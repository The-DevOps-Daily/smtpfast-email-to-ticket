import type { AppConfig } from "../src/config.js";
import type {
  AttachmentTarget,
  InboundJob,
  InboundMailClient,
  InboundMessageInput,
  TicketDetail,
  TicketStore,
  TicketSummary,
} from "../src/domain.js";
import type {
  ReceivedAttachment,
  ReceivedEmail,
  ReceivedEmailSummary,
  SmtpfastWebhookEvent,
} from "../src/smtpfast/types.js";

export const testConfig: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 3000,
  databaseUrl: "postgres://unused",
  smtpfastBaseUrl: "https://smtpfa.st/api/v1",
  smtpfastApiKey: "sf_test_example",
  smtpfastWebhookSecret: "whsec_test_secret",
  appSecret: "app_test_secret_that_is_long_enough_for_tests",
  inboundAddress: "support@inbound.example.com",
  ingestMode: "webhook",
  adminUsername: "admin",
  adminPassword: "a-secure-test-password",
  workerEnabled: false,
  workerPollMs: 1_000,
  workerBatchSize: 5,
  workerMaxAttempts: 8,
};

export const receivedEmail: ReceivedEmail = {
  object: "email",
  id: "rcv_01test",
  to: ["support@inbound.example.com"],
  from: "Ada Lovelace <ada@example.net>",
  created_at: "2026-09-25T10:00:00.000Z",
  subject: "The export is incomplete",
  bcc: [],
  cc: [],
  reply_to: [],
  received_for: ["support@inbound.example.com"],
  message_id: "<message-1@example.net>",
  attachments: [],
  html: "<p>Please help.</p>",
  text: "Please help.",
  status: "delivered",
  envelope_from: "ada@example.net",
  envelope_to: ["support@inbound.example.com"],
  verdicts: { spf: "PASS", dkim: "PASS", dmarc: "PASS", spam: "PASS", virus: "PASS" },
  in_reply_to: null,
  references: [],
};

export function webhookEvent(): SmtpfastWebhookEvent {
  return {
    id: "evt_01test",
    type: "email.received",
    timestamp: "2026-09-25T10:00:01.000Z",
    data: {
      object: "email",
      id: receivedEmail.id,
      from: receivedEmail.from,
      to: receivedEmail.to,
      received_for: receivedEmail.received_for,
      subject: receivedEmail.subject,
      created_at: receivedEmail.created_at,
      attachments: [],
      status: "delivered",
      domain_id: "dom_01test",
    },
  };
}

export class FakeStore implements TicketStore {
  jobs: InboundJob[] = [];
  saved: InboundMessageInput[] = [];
  ignored: Array<{ id: string; reason: string }> = [];
  rescheduled: Array<{ id: string; error: string; availableAt: Date }> = [];
  failed: Array<{ id: string; error: string }> = [];
  completed: string[] = [];
  tickets: TicketSummary[] = [];
  ticket: TicketDetail | null = null;
  eventKeys = new Set<string>();

  async enqueueInboundJob(
    eventKey: string,
    receivedId: string,
    payload: SmtpfastWebhookEvent,
  ): Promise<boolean> {
    if (this.eventKeys.has(eventKey)) return false;
    this.eventKeys.add(eventKey);
    this.jobs.push({
      id: "job_01test",
      eventKey,
      smtpfastReceivedId: receivedId,
      payload,
      attempts: 1,
    });
    return true;
  }

  async claimInboundJobs(limit: number): Promise<InboundJob[]> {
    return this.jobs.splice(0, limit);
  }

  async saveInboundMessage(input: InboundMessageInput): Promise<string> {
    this.saved.push(input);
    return "42";
  }

  async markJobIgnored(id: string, reason: string): Promise<void> {
    this.ignored.push({ id, reason });
  }

  async markJobCompleted(id: string): Promise<void> {
    this.completed.push(id);
  }

  async rescheduleJob(id: string, error: string, availableAt: Date): Promise<void> {
    this.rescheduled.push({ id, error, availableAt });
  }

  async markJobFailed(id: string, error: string): Promise<void> {
    this.failed.push({ id, error });
  }

  async listTickets(): Promise<TicketSummary[]> {
    return this.tickets;
  }

  async getTicket(): Promise<TicketDetail | null> {
    return this.ticket;
  }

  async recordOutboundReply(): Promise<void> {}

  async getAttachmentTarget(): Promise<AttachmentTarget | null> {
    return null;
  }

  async ping(): Promise<void> {}
}

export class FakeMailClient implements InboundMailClient {
  message: ReceivedEmail = receivedEmail;
  summaries = [webhookEvent().data];
  error: Error | undefined;

  async listReceivedEmails(): Promise<ReceivedEmailSummary[]> {
    if (this.error) throw this.error;
    return this.summaries;
  }

  async getReceivedEmail(): Promise<ReceivedEmail> {
    if (this.error) throw this.error;
    return this.message;
  }

  async getReceivedAttachment(): Promise<ReceivedAttachment> {
    throw new Error("Not implemented in fake");
  }

  async replyToReceivedEmail(): Promise<{ id: string }> {
    return { id: "em_reply" };
  }
}
