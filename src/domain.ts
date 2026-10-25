import type {
  ReceivedAttachment,
  ReceivedEmail,
  ReceivedEmailSummary,
  SmtpfastWebhookEvent,
} from "./smtpfast/types.js";

export type InboundJob = {
  id: string;
  eventKey: string;
  smtpfastReceivedId: string;
  payload: SmtpfastWebhookEvent;
  attempts: number;
};

export type InboundMessageInput = {
  jobId: string;
  mailbox: string;
  requesterEmail: string;
  requesterLabel: string;
  ticketNumberHint?: string;
  message: ReceivedEmail;
};

export type TicketSummary = {
  id: string;
  number: string;
  status: "open" | "closed" | "quarantined";
  subject: string;
  requesterEmail: string;
  requesterLabel: string;
  mailbox: string;
  createdAt: Date;
  updatedAt: Date;
  lastMessageAt: Date;
  messageCount: number;
};

export type StoredAttachment = {
  id: string;
  smtpfastAttachmentId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
};

export type StoredMessage = {
  id: string;
  direction: "inbound" | "outbound";
  smtpfastReceivedId: string | null;
  smtpfastEmailId: string | null;
  fromHeader: string;
  toHeaders: string[];
  subject: string;
  textBody: string | null;
  receivedAt: Date;
  verdicts: Record<string, string>;
  quarantined: boolean;
  attachments: StoredAttachment[];
};

export type TicketDetail = TicketSummary & {
  messages: StoredMessage[];
};

export type AttachmentTarget = {
  smtpfastReceivedId: string;
  smtpfastAttachmentId: string;
  filename: string;
};

export interface TicketStore {
  enqueueInboundJob(
    eventKey: string,
    receivedId: string,
    payload: SmtpfastWebhookEvent,
  ): Promise<boolean>;
  claimInboundJobs(limit: number): Promise<InboundJob[]>;
  saveInboundMessage(input: InboundMessageInput): Promise<string>;
  markJobIgnored(jobId: string, reason: string): Promise<void>;
  markJobCompleted(jobId: string): Promise<void>;
  rescheduleJob(jobId: string, error: string, availableAt: Date): Promise<void>;
  markJobFailed(jobId: string, error: string): Promise<void>;
  listTickets(limit?: number): Promise<TicketSummary[]>;
  getTicket(number: string): Promise<TicketDetail | null>;
  recordOutboundReply(input: {
    ticketId: string;
    smtpfastEmailId: string;
    inReplyToReceivedId: string;
    fromHeader: string;
    toHeaders: string[];
    subject: string;
    textBody: string;
  }): Promise<void>;
  getAttachmentTarget(attachmentId: string): Promise<AttachmentTarget | null>;
  ping(): Promise<void>;
}

export interface InboundMailClient {
  listReceivedEmails(limit?: number): Promise<ReceivedEmailSummary[]>;
  getReceivedEmail(id: string): Promise<ReceivedEmail>;
  getReceivedAttachment(
    receivedId: string,
    attachmentId: string,
  ): Promise<ReceivedAttachment>;
  replyToReceivedEmail(
    receivedId: string,
    body: { subject?: string; text: string },
  ): Promise<{ id: string }>;
}
