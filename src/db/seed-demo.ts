import "dotenv/config";
import { extractDisplayLabel, extractEmailAddress } from "../lib/email.js";
import type { ReceivedEmail, SmtpfastWebhookEvent } from "../smtpfast/types.js";
import { createPool } from "./pool.js";
import { PostgresTicketStore } from "./store.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const pool = createPool(databaseUrl);
const store = new PostgresTicketStore(pool);

function eventFor(message: ReceivedEmail): SmtpfastWebhookEvent {
  return {
    id: `evt_${message.id}`,
    type: "email.received",
    timestamp: message.created_at,
    data: {
      object: "email",
      id: message.id,
      from: message.from,
      to: message.to,
      received_for: message.received_for,
      subject: message.subject,
      created_at: message.created_at,
      attachments: message.attachments,
      status: message.status,
      domain_id: "dom_demo",
    },
  };
}

async function persist(message: ReceivedEmail): Promise<string | undefined> {
  const event = eventFor(message);
  const inserted = await store.enqueueInboundJob(event.id!, message.id, event);
  if (!inserted) return undefined;
  const [job] = await store.claimInboundJobs(1);
  if (!job) throw new Error("Could not claim seeded job");
  return store.saveInboundMessage({
    jobId: job.id,
    mailbox: "support@inbound.example.com",
    requesterEmail: extractEmailAddress(message.from),
    requesterLabel: extractDisplayLabel(message.from),
    message,
  });
}

const first: ReceivedEmail = {
  id: "rcv_demo_export_1",
  object: "email",
  to: ["Support <support@inbound.example.com>"],
  from: "Ada Lovelace <ada@example.net>",
  created_at: "2026-09-25T08:42:00.000Z",
  subject: "CSV export is missing last week",
  bcc: [],
  cc: [],
  reply_to: [],
  received_for: ["support@inbound.example.com"],
  message_id: "<demo-export-1@example.net>",
  attachments: [
    {
      id: "att_demo_csv",
      filename: "export-sample.csv",
      content_type: "text/csv",
      size: 18_432,
    },
  ],
  text: "Hi team,\n\nThe CSV export stops at September 17. I attached a small sample. Could you take a look?\n\nThanks,\nAda",
  html: "<p>Hi team,</p><p>The CSV export stops at September 17.</p>",
  status: "delivered",
  envelope_from: "ada@example.net",
  envelope_to: ["support@inbound.example.com"],
  verdicts: { spf: "PASS", dkim: "PASS", dmarc: "PASS", spam: "PASS", virus: "PASS" },
  in_reply_to: null,
  references: [],
};

try {
  const ticketNumber = await persist(first);
  if (ticketNumber) {
    const ticket = await store.getTicket(ticketNumber);
    if (!ticket) throw new Error("Seeded ticket was not found");
    await store.recordOutboundReply({
      ticketId: ticket.id,
      smtpfastEmailId: "em_demo_reply_1",
      inReplyToReceivedId: first.id,
      fromHeader: "support@inbound.example.com",
      toHeaders: ["ada@example.net"],
      subject: `Re: [Ticket #${ticketNumber}] CSV export is missing last week`,
      textBody: "Thanks, Ada. We found a timezone boundary in the export worker and deployed a fix. Would you try the export again?",
    });

    await persist({
      ...first,
      id: "rcv_demo_export_2",
      created_at: "2026-09-25T09:48:00.000Z",
      subject: `Re: [Ticket #${ticketNumber}] CSV export is missing last week`,
      message_id: "<demo-export-2@example.net>",
      in_reply_to: "<smtpfast-demo-reply@example.com>",
      references: ["<demo-export-1@example.net>", "<smtpfast-demo-reply@example.com>"],
      attachments: [],
      text: "That did it — all rows are present now. Thank you!",
    });
  }

  await persist({
    ...first,
    id: "rcv_demo_quarantine",
    from: "Unknown sender <unknown@untrusted.example>",
    subject: "Urgent invoice executable",
    created_at: "2026-09-25T09:26:00.000Z",
    message_id: "<demo-quarantine@untrusted.example>",
    status: "quarantined",
    text: null,
    html: null,
    attachments: [],
    verdicts: { spf: "FAIL", dkim: "FAIL", dmarc: "FAIL", spam: "FAIL", virus: "FAIL" },
  });

  console.log("Demo tickets are ready");
} finally {
  await pool.end();
}
