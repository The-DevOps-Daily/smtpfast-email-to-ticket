import { z } from "zod";

export const receivedAttachmentSchema = z.object({
  id: z.string(),
  filename: z.string(),
  content_type: z.string().default("application/octet-stream"),
  content_disposition: z.string().optional(),
  content_id: z.string().nullable().optional(),
  size: z.number().int().nonnegative(),
  download_url: z.string().url().optional(),
  expires_at: z.string().datetime().optional(),
});

export type ReceivedAttachment = z.infer<typeof receivedAttachmentSchema>;

const verdictsSchema = z
  .object({
    spf: z.string().optional(),
    dkim: z.string().optional(),
    dmarc: z.string().optional(),
    spam: z.string().optional(),
    virus: z.string().optional(),
  })
  .catchall(z.string());

export const receivedEmailSchema = z.object({
  object: z.string().optional(),
  id: z.string(),
  to: z.array(z.string()).default([]),
  from: z.string(),
  created_at: z.string().datetime(),
  subject: z.string().default("(no subject)"),
  bcc: z.array(z.string()).default([]),
  cc: z.array(z.string()).default([]),
  reply_to: z.array(z.string()).default([]),
  received_for: z.array(z.string()).default([]),
  message_id: z.string().nullable().optional(),
  attachments: z.array(receivedAttachmentSchema).default([]),
  html: z.string().nullable().optional(),
  text: z.string().nullable().optional(),
  headers: z.record(z.string(), z.unknown()).optional(),
  status: z.string(),
  envelope_from: z.string().optional(),
  envelope_to: z.array(z.string()).default([]),
  domain_id: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  verdicts: verdictsSchema.default({}),
  in_reply_to: z.string().nullable().optional(),
  references: z.array(z.string()).default([]),
});

export type ReceivedEmail = z.infer<typeof receivedEmailSchema>;

export const receivedEmailSummarySchema = z.object({
  object: z.string().optional(),
  id: z.string(),
  from: z.string(),
  to: z.array(z.string()).default([]),
  received_for: z.array(z.string()).default([]),
  subject: z.string().default("(no subject)"),
  created_at: z.string().datetime(),
  attachments: z.array(receivedAttachmentSchema).default([]),
  status: z.string(),
  domain_id: z.string().optional(),
});

export type ReceivedEmailSummary = z.infer<typeof receivedEmailSummarySchema>;

export const receivedEmailListSchema = z.object({
  object: z.string().optional(),
  has_more: z.boolean().default(false),
  data: z.array(receivedEmailSummarySchema),
});

export const smtpfastWebhookEventSchema = z.object({
  id: z.string().optional(),
  type: z.string(),
  timestamp: z.string().datetime(),
  data: receivedEmailSummarySchema,
});

export type SmtpfastWebhookEvent = z.infer<typeof smtpfastWebhookEventSchema>;
