import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool } from "../src/db/pool.js";
import { PostgresTicketStore } from "../src/db/store.js";
import type { SmtpfastWebhookEvent } from "../src/smtpfast/types.js";
import { receivedEmail, webhookEvent } from "./helpers.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = describe.skipIf(!databaseUrl);

suite("PostgresTicketStore", () => {
  const pool = createPool(databaseUrl ?? "postgres://unused");
  const store = new PostgresTicketStore(pool);

  beforeAll(async () => {
    await store.ping();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE attachments, messages, tickets, inbound_jobs RESTART IDENTITY CASCADE");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("deduplicates jobs and threads replies using References", async () => {
    const firstEvent = webhookEvent();
    expect(await store.enqueueInboundJob(firstEvent.id!, receivedEmail.id, firstEvent)).toBe(true);
    expect(await store.enqueueInboundJob(firstEvent.id!, receivedEmail.id, firstEvent)).toBe(false);

    const [firstJob] = await store.claimInboundJobs(1);
    expect(firstJob).toBeDefined();
    const firstTicket = await store.saveInboundMessage({
      jobId: firstJob!.id,
      mailbox: "support@inbound.example.com",
      requesterEmail: "ada@example.net",
      requesterLabel: "Ada Lovelace",
      message: receivedEmail,
    });

    const reply = {
      ...receivedEmail,
      id: "rcv_02test",
      subject: "Re: The export is incomplete",
      created_at: "2026-09-25T10:05:00.000Z",
      message_id: "<message-2@example.net>",
      in_reply_to: "<outbound-reply@example.com>",
      references: ["<message-1@example.net>", "<outbound-reply@example.com>"],
      text: "That fixed it, thank you.",
    };
    const secondEvent: SmtpfastWebhookEvent = {
      ...firstEvent,
      id: "evt_02test",
      data: { ...firstEvent.data, id: reply.id, created_at: reply.created_at },
    };
    await store.enqueueInboundJob(secondEvent.id!, reply.id, secondEvent);
    const [secondJob] = await store.claimInboundJobs(1);
    const secondTicket = await store.saveInboundMessage({
      jobId: secondJob!.id,
      mailbox: "support@inbound.example.com",
      requesterEmail: "ada@example.net",
      requesterLabel: "Ada Lovelace",
      message: reply,
    });

    expect(secondTicket).toBe(firstTicket);
    const ticket = await store.getTicket(firstTicket);
    expect(ticket?.messageCount).toBe(2);
    expect(ticket?.messages.map((message) => message.smtpfastReceivedId)).toEqual([
      "rcv_01test",
      "rcv_02test",
    ]);
  });

  it("stores only metadata for a quarantined message", async () => {
    const event = webhookEvent();
    await store.enqueueInboundJob(event.id!, receivedEmail.id, event);
    const [job] = await store.claimInboundJobs(1);
    const ticketNumber = await store.saveInboundMessage({
      jobId: job!.id,
      mailbox: "support@inbound.example.com",
      requesterEmail: "ada@example.net",
      requesterLabel: "Ada Lovelace",
      message: {
        ...receivedEmail,
        status: "quarantined",
        text: "This content must not be stored",
        attachments: [
          {
            id: "att_dangerous",
            filename: "payload.exe",
            content_type: "application/octet-stream",
            size: 123,
          },
        ],
        verdicts: { ...receivedEmail.verdicts, virus: "FAIL" },
      },
    });

    const ticket = await store.getTicket(ticketNumber);
    expect(ticket?.status).toBe("quarantined");
    expect(ticket?.messages[0]?.textBody).toBeNull();
    expect(ticket?.messages[0]?.attachments).toEqual([]);
  });

  it("does not trust a ticket number in a different sender's subject", async () => {
    const firstEvent = webhookEvent();
    await store.enqueueInboundJob(firstEvent.id!, receivedEmail.id, firstEvent);
    const [firstJob] = await store.claimInboundJobs(1);
    const originalTicket = await store.saveInboundMessage({
      jobId: firstJob!.id,
      mailbox: "support@inbound.example.com",
      requesterEmail: "ada@example.net",
      requesterLabel: "Ada Lovelace",
      message: receivedEmail,
    });

    const spoofed = {
      ...receivedEmail,
      id: "rcv_spoofed",
      from: "Mallory <mallory@example.org>",
      created_at: "2026-09-25T10:10:00.000Z",
      subject: `Re: [Ticket #${originalTicket}] The export is incomplete`,
      message_id: "<spoofed@example.org>",
      in_reply_to: null,
      references: [],
    };
    const spoofedEvent: SmtpfastWebhookEvent = {
      ...firstEvent,
      id: "evt_spoofed",
      data: {
        ...firstEvent.data,
        id: spoofed.id,
        from: spoofed.from,
        subject: spoofed.subject,
        created_at: spoofed.created_at,
      },
    };
    await store.enqueueInboundJob(spoofedEvent.id!, spoofed.id, spoofedEvent);
    const [spoofedJob] = await store.claimInboundJobs(1);
    const resultingTicket = await store.saveInboundMessage({
      jobId: spoofedJob!.id,
      mailbox: "support@inbound.example.com",
      requesterEmail: "mallory@example.org",
      requesterLabel: "Mallory",
      ticketNumberHint: originalTicket,
      message: spoofed,
    });

    expect(resultingTicket).not.toBe(originalTicket);
    expect(await store.listTickets()).toHaveLength(2);
  });
});
