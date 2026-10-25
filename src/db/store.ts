import type { Pool, PoolClient } from "pg";
import type {
  AttachmentTarget,
  InboundJob,
  InboundMessageInput,
  StoredAttachment,
  StoredMessage,
  TicketDetail,
  TicketStore,
  TicketSummary,
} from "../domain.js";

type TicketRow = {
  id: string;
  number: string;
  status: "open" | "closed" | "quarantined";
  subject: string;
  requester_email: string;
  requester_label: string;
  mailbox: string;
  created_at: Date;
  updated_at: Date;
  last_message_at: Date;
  message_count: string;
};

function mapTicket(row: TicketRow): TicketSummary {
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    subject: row.subject,
    requesterEmail: row.requester_email,
    requesterLabel: row.requester_label,
    mailbox: row.mailbox,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastMessageAt: row.last_message_at,
    messageCount: Number(row.message_count),
  };
}

export class PostgresTicketStore implements TicketStore {
  constructor(private readonly pool: Pool) {}

  async enqueueInboundJob(
    eventKey: string,
    receivedId: string,
    payload: InboundJob["payload"],
  ): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO inbound_jobs (event_key, smtpfast_received_id, payload)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (event_key) DO NOTHING
       RETURNING id`,
      [eventKey, receivedId, JSON.stringify(payload)],
    );
    return result.rowCount === 1;
  }

  async claimInboundJobs(limit: number): Promise<InboundJob[]> {
    const result = await this.pool.query<{
      id: string;
      event_key: string;
      smtpfast_received_id: string;
      payload: InboundJob["payload"];
      attempts: number;
    }>(
      `WITH next_jobs AS (
         SELECT id
         FROM inbound_jobs
         WHERE (status = 'pending' AND available_at <= now())
            OR (status = 'processing' AND locked_at < now() - interval '5 minutes')
         ORDER BY available_at, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       UPDATE inbound_jobs AS jobs
       SET status = 'processing', attempts = attempts + 1, locked_at = now()
       FROM next_jobs
       WHERE jobs.id = next_jobs.id
       RETURNING jobs.id, jobs.event_key, jobs.smtpfast_received_id, jobs.payload, jobs.attempts`,
      [limit],
    );

    return result.rows.map((row) => ({
      id: row.id,
      eventKey: row.event_key,
      smtpfastReceivedId: row.smtpfast_received_id,
      payload: row.payload,
      attempts: row.attempts,
    }));
  }

  async saveInboundMessage(input: InboundMessageInput): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const existing = await client.query<{ number: string }>(
        `SELECT tickets.number
         FROM messages
         JOIN tickets ON tickets.id = messages.ticket_id
         WHERE messages.smtpfast_received_id = $1`,
        [input.message.id],
      );
      const existingNumber = existing.rows[0]?.number;
      if (existingNumber) {
        await this.completeInsideTransaction(client, input.jobId);
        await client.query("COMMIT");
        return existingNumber;
      }

      const relatedMessageIds = [
        ...(input.message.in_reply_to ? [input.message.in_reply_to] : []),
        ...input.message.references,
      ];

      let ticketId: string | undefined;
      let ticketNumber: string | undefined;

      if (relatedMessageIds.length > 0) {
        const related = await client.query<{ id: string; number: string }>(
          `SELECT tickets.id, tickets.number
           FROM messages
           JOIN tickets ON tickets.id = messages.ticket_id
           WHERE messages.internet_message_id = ANY($1::text[])
           ORDER BY messages.received_at DESC
           LIMIT 1`,
          [relatedMessageIds],
        );
        ticketId = related.rows[0]?.id;
        ticketNumber = related.rows[0]?.number;
      }

      if (!ticketId && input.ticketNumberHint) {
        const hinted = await client.query<{ id: string; number: string }>(
          `SELECT id, number
           FROM tickets
           WHERE number = $1 AND lower(requester_email) = lower($2)`,
          [input.ticketNumberHint, input.requesterEmail],
        );
        ticketId = hinted.rows[0]?.id;
        ticketNumber = hinted.rows[0]?.number;
      }

      const quarantined =
        input.message.status.toLowerCase() === "quarantined" ||
        (input.message.verdicts.virus?.toUpperCase() ?? "PASS") !== "PASS";

      if (!ticketId) {
        const created = await client.query<{ id: string; number: string }>(
          `INSERT INTO tickets
             (status, subject, requester_email, requester_label, mailbox, last_message_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, number`,
          [
            quarantined ? "quarantined" : "open",
            input.message.subject,
            input.requesterEmail,
            input.requesterLabel,
            input.mailbox,
            input.message.created_at,
          ],
        );
        ticketId = created.rows[0]?.id;
        ticketNumber = created.rows[0]?.number;
      }

      if (!ticketId || !ticketNumber) {
        throw new Error("Could not resolve a ticket for the inbound message");
      }

      const insertedMessage = await client.query<{ id: string }>(
        `INSERT INTO messages
           (ticket_id, direction, smtpfast_received_id, internet_message_id, in_reply_to,
            message_references, from_header, to_headers, subject, text_body, received_at,
            verdicts, quarantined)
         VALUES ($1, 'inbound', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
         RETURNING id`,
        [
          ticketId,
          input.message.id,
          input.message.message_id ?? null,
          input.message.in_reply_to ?? null,
          input.message.references,
          input.message.from,
          input.message.to,
          input.message.subject,
          quarantined ? null : (input.message.text ?? null),
          input.message.created_at,
          JSON.stringify(input.message.verdicts),
          quarantined,
        ],
      );

      const messageId = insertedMessage.rows[0]?.id;
      if (!messageId) {
        throw new Error("Could not persist the inbound message");
      }

      if (!quarantined) {
        for (const attachment of input.message.attachments) {
          await client.query(
            `INSERT INTO attachments
               (message_id, smtpfast_attachment_id, filename, content_type, size_bytes)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (message_id, smtpfast_attachment_id) DO NOTHING`,
            [
              messageId,
              attachment.id,
              attachment.filename,
              attachment.content_type,
              attachment.size,
            ],
          );
        }
      }

      await client.query(
        `UPDATE tickets
         SET updated_at = now(), last_message_at = GREATEST(last_message_at, $2)
         WHERE id = $1`,
        [ticketId, input.message.created_at],
      );
      await this.completeInsideTransaction(client, input.jobId);
      await client.query("COMMIT");
      return ticketNumber;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markJobIgnored(jobId: string, reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE inbound_jobs
       SET status = 'ignored', completed_at = now(), locked_at = null, last_error = $2
       WHERE id = $1`,
      [jobId, reason],
    );
  }

  async markJobCompleted(jobId: string): Promise<void> {
    await this.pool.query(
      `UPDATE inbound_jobs
       SET status = 'completed', completed_at = now(), locked_at = null, last_error = null
       WHERE id = $1`,
      [jobId],
    );
  }

  async rescheduleJob(jobId: string, error: string, availableAt: Date): Promise<void> {
    await this.pool.query(
      `UPDATE inbound_jobs
       SET status = 'pending', available_at = $2, locked_at = null, last_error = $3
       WHERE id = $1`,
      [jobId, availableAt, error.slice(0, 2_000)],
    );
  }

  async markJobFailed(jobId: string, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE inbound_jobs
       SET status = 'failed', completed_at = now(), locked_at = null, last_error = $2
       WHERE id = $1`,
      [jobId, error.slice(0, 2_000)],
    );
  }

  async listTickets(limit = 100): Promise<TicketSummary[]> {
    const result = await this.pool.query<TicketRow>(
      `SELECT tickets.*, count(messages.id)::text AS message_count
       FROM tickets
       LEFT JOIN messages ON messages.ticket_id = tickets.id
       GROUP BY tickets.id
       ORDER BY tickets.last_message_at DESC
       LIMIT $1`,
      [limit],
    );
    return result.rows.map(mapTicket);
  }

  async getTicket(number: string): Promise<TicketDetail | null> {
    const ticketResult = await this.pool.query<TicketRow>(
      `SELECT tickets.*, count(messages.id)::text AS message_count
       FROM tickets
       LEFT JOIN messages ON messages.ticket_id = tickets.id
       WHERE tickets.number = $1
       GROUP BY tickets.id`,
      [number],
    );
    const row = ticketResult.rows[0];
    if (!row) return null;

    const messageResult = await this.pool.query<{
      id: string;
      direction: "inbound" | "outbound";
      smtpfast_received_id: string | null;
      smtpfast_email_id: string | null;
      from_header: string;
      to_headers: string[];
      subject: string;
      text_body: string | null;
      received_at: Date;
      verdicts: Record<string, string>;
      quarantined: boolean;
    }>(
      `SELECT id, direction, smtpfast_received_id, smtpfast_email_id, from_header,
              to_headers, subject, text_body, received_at, verdicts, quarantined
       FROM messages
       WHERE ticket_id = $1
       ORDER BY received_at, created_at`,
      [row.id],
    );

    const attachmentResult = await this.pool.query<{
      id: string;
      message_id: string;
      smtpfast_attachment_id: string;
      filename: string;
      content_type: string;
      size_bytes: string;
    }>(
      `SELECT attachments.id, attachments.message_id, attachments.smtpfast_attachment_id,
              attachments.filename, attachments.content_type, attachments.size_bytes
       FROM attachments
       JOIN messages ON messages.id = attachments.message_id
       WHERE messages.ticket_id = $1
       ORDER BY attachments.created_at`,
      [row.id],
    );

    const attachmentsByMessage = new Map<string, StoredAttachment[]>();
    for (const attachment of attachmentResult.rows) {
      const current = attachmentsByMessage.get(attachment.message_id) ?? [];
      current.push({
        id: attachment.id,
        smtpfastAttachmentId: attachment.smtpfast_attachment_id,
        filename: attachment.filename,
        contentType: attachment.content_type,
        sizeBytes: Number(attachment.size_bytes),
      });
      attachmentsByMessage.set(attachment.message_id, current);
    }

    const messages: StoredMessage[] = messageResult.rows.map((message) => ({
      id: message.id,
      direction: message.direction,
      smtpfastReceivedId: message.smtpfast_received_id,
      smtpfastEmailId: message.smtpfast_email_id,
      fromHeader: message.from_header,
      toHeaders: message.to_headers,
      subject: message.subject,
      textBody: message.text_body,
      receivedAt: message.received_at,
      verdicts: message.verdicts,
      quarantined: message.quarantined,
      attachments: attachmentsByMessage.get(message.id) ?? [],
    }));

    return { ...mapTicket(row), messages };
  }

  async recordOutboundReply(input: {
    ticketId: string;
    smtpfastEmailId: string;
    inReplyToReceivedId: string;
    fromHeader: string;
    toHeaders: string[];
    subject: string;
    textBody: string;
  }): Promise<void> {
    await this.pool.query(
      `WITH inserted AS (
         INSERT INTO messages
           (ticket_id, direction, smtpfast_email_id, from_header, to_headers,
            subject, text_body, received_at, verdicts)
         VALUES ($1, 'outbound', $2, $3, $4, $5, $6, now(), '{}'::jsonb)
         ON CONFLICT (smtpfast_email_id) DO NOTHING
         RETURNING ticket_id
       )
       UPDATE tickets
       SET updated_at = now(), last_message_at = now()
       WHERE id IN (SELECT ticket_id FROM inserted)`,
      [
        input.ticketId,
        input.smtpfastEmailId,
        input.fromHeader,
        input.toHeaders,
        input.subject,
        input.textBody,
      ],
    );
  }

  async getAttachmentTarget(attachmentId: string): Promise<AttachmentTarget | null> {
    const result = await this.pool.query<{
      smtpfast_received_id: string;
      smtpfast_attachment_id: string;
      filename: string;
    }>(
      `SELECT messages.smtpfast_received_id, attachments.smtpfast_attachment_id,
              attachments.filename
       FROM attachments
       JOIN messages ON messages.id = attachments.message_id
       WHERE attachments.id = $1 AND messages.smtpfast_received_id IS NOT NULL`,
      [attachmentId],
    );
    const row = result.rows[0];
    return row
      ? {
          smtpfastReceivedId: row.smtpfast_received_id,
          smtpfastAttachmentId: row.smtpfast_attachment_id,
          filename: row.filename,
        }
      : null;
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  private async completeInsideTransaction(client: PoolClient, jobId: string): Promise<void> {
    await client.query(
      `UPDATE inbound_jobs
       SET status = 'completed', completed_at = now(), locked_at = null, last_error = null
       WHERE id = $1`,
      [jobId],
    );
  }
}
