CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS inbound_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key text NOT NULL UNIQUE,
  smtpfast_received_id text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'ignored', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS inbound_jobs_ready_idx
  ON inbound_jobs (available_at, created_at)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'closed', 'quarantined')),
  subject text NOT NULL,
  requester_email text NOT NULL,
  requester_label text NOT NULL,
  mailbox text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tickets_recent_idx
  ON tickets (last_message_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  smtpfast_received_id text UNIQUE,
  smtpfast_email_id text UNIQUE,
  internet_message_id text,
  in_reply_to text,
  message_references text[] NOT NULL DEFAULT '{}',
  from_header text NOT NULL,
  to_headers text[] NOT NULL DEFAULT '{}',
  subject text NOT NULL,
  text_body text,
  received_at timestamptz NOT NULL,
  verdicts jsonb NOT NULL DEFAULT '{}',
  quarantined boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_ticket_idx
  ON messages (ticket_id, received_at);

CREATE INDEX IF NOT EXISTS messages_message_id_idx
  ON messages (internet_message_id)
  WHERE internet_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  smtpfast_attachment_id text NOT NULL,
  filename text NOT NULL,
  content_type text NOT NULL,
  size_bytes bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, smtpfast_attachment_id)
);

CREATE INDEX IF NOT EXISTS attachments_message_idx
  ON attachments (message_id);
