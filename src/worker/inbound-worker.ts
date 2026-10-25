import type { AppConfig } from "../config.js";
import type { InboundJob, InboundMailClient, TicketStore } from "../domain.js";
import {
  extractDisplayLabel,
  extractEmailAddress,
  normalizeAddress,
  ticketNumberFromSubject,
} from "../lib/email.js";
import { SmtpfastApiError } from "../smtpfast/client.js";

type WorkerLogger = {
  info(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
};

export class InboundWorker {
  private timer: NodeJS.Timeout | undefined;
  private stopped = true;
  private running = false;

  constructor(
    private readonly config: Pick<
      AppConfig,
      | "inboundAddress"
      | "ingestMode"
      | "workerPollMs"
      | "workerBatchSize"
      | "workerMaxAttempts"
    >,
    private readonly store: TicketStore,
    private readonly mailClient: InboundMailClient,
    private readonly logger: WorkerLogger,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      if (this.config.ingestMode === "poll") {
        await this.pollForReceivedEmails();
      }
      const jobs = await this.store.claimInboundJobs(this.config.workerBatchSize);
      await Promise.all(jobs.map((job) => this.process(job)));
      return jobs.length;
    } finally {
      this.running = false;
    }
  }

  private async pollForReceivedEmails(): Promise<void> {
    const messages = await this.mailClient.listReceivedEmails(100);
    let inserted = 0;

    for (const message of [...messages].reverse()) {
      const event = {
        id: `poll:${message.id}`,
        type: "email.received",
        timestamp: message.created_at,
        data: message,
      };
      if (await this.store.enqueueInboundJob(`received:${message.id}`, message.id, event)) {
        inserted += 1;
      }
    }

    if (inserted > 0) {
      this.logger.info({ inserted }, "Queued received emails from SMTPfast polling");
    }
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(async () => {
      try {
        await this.runOnce();
      } catch (error) {
        this.logger.error({ error }, "Inbound worker cycle failed");
      } finally {
        if (!this.stopped) this.schedule(this.config.workerPollMs);
      }
    }, delay);
  }

  private async process(job: InboundJob): Promise<void> {
    try {
      const message = await this.mailClient.getReceivedEmail(job.smtpfastReceivedId);
      const envelopeRecipients =
        message.received_for.length > 0 ? message.received_for : message.envelope_to;
      const intendedForMailbox = envelopeRecipients
        .map(normalizeAddress)
        .includes(this.config.inboundAddress);

      if (!intendedForMailbox) {
        await this.store.markJobIgnored(
          job.id,
          `Envelope recipient did not match ${this.config.inboundAddress}`,
        );
        this.logger.info(
          { receivedId: message.id, envelopeRecipients },
          "Ignored email for an unconfigured catch-all address",
        );
        return;
      }

      const ticketNumberHint = ticketNumberFromSubject(message.subject);
      const ticketNumber = await this.store.saveInboundMessage({
        jobId: job.id,
        mailbox: this.config.inboundAddress,
        requesterEmail: extractEmailAddress(message.from),
        requesterLabel: extractDisplayLabel(message.from),
        ...(ticketNumberHint ? { ticketNumberHint } : {}),
        message,
      });
      this.logger.info(
        { receivedId: message.id, ticketNumber },
        "Stored inbound email on ticket",
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown inbound processing error";
      const permanentlyFailed =
        job.attempts >= this.config.workerMaxAttempts ||
        (error instanceof SmtpfastApiError && !error.retryable);

      if (permanentlyFailed) {
        await this.store.markJobFailed(job.id, detail);
        this.logger.error(
          { jobId: job.id, receivedId: job.smtpfastReceivedId, error },
          "Inbound email processing failed permanently",
        );
        return;
      }

      const delayMs = Math.min(300_000, 1_000 * 2 ** Math.max(0, job.attempts - 1));
      await this.store.rescheduleJob(job.id, detail, new Date(Date.now() + delayMs));
      this.logger.error(
        { jobId: job.id, receivedId: job.smtpfastReceivedId, delayMs, error },
        "Inbound email processing will retry",
      );
    }
  }
}
