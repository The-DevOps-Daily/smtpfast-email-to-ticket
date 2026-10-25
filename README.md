# SMTPfast Email-to-Ticket

A small, production-minded support inbox built with TypeScript, Fastify, PostgreSQL, and [SMTPfast inbound email](https://smtpfa.st/docs/inbound).

An email sent to a configured address becomes a durable ticket. Replies are grouped into the same conversation using standard email threading headers, and agents can respond from the web UI without leaving the thread.

This is a tutorial project for developers familiar with basic TypeScript, HTTP APIs, and SQL. Start with local polling to try the email-to-ticket flow; webhook ingestion is an optional extension for a deployed app. SMTPfast handles receiving email, so no IMAP server or Gmail forwarding is required.

## What this project demonstrates

- A no-tunnel local quickstart that polls the SMTPfast receiving API
- HMAC-SHA256 verification over the **raw** webhook request body
- Fast webhook acknowledgement backed by a PostgreSQL job queue
- Retry deduplication with a provider event ID or stable body hash
- Catch-all routing using the SMTP envelope recipient, not the visible `To` header
- Thread matching through `Message-ID`, `In-Reply-To`, and `References`
- A `[Ticket #N]` subject marker as a fallback for clients that lose threading headers
- Quarantine-aware ingestion that never stores unavailable message content
- Plain-text rendering with HTML escaping instead of rendering untrusted email HTML
- On-demand, short-lived attachment URLs
- Thread-preserving replies through the SMTPfast receiving API
- A Basic-authenticated ticket UI with ticket-bound form tokens
- Bounded worker retries and recovery of jobs left locked by a crashed process

## Architecture

```text
Internet sender
      │ SMTP
      ▼
SMTPfast inbound domain
      │
      ├── local quickstart: poll GET /emails/receiving
      │
      └── production option: signed email.received webhook
                              │
                              ▼
                    POST /webhooks/smtpfast
                              │ verify raw-body HMAC
      ▼
PostgreSQL inbound_jobs
      │ claim with FOR UPDATE SKIP LOCKED
      ▼
Inbound worker ── GET full message ──► SMTPfast API
      │
      ├──► tickets / messages / attachment metadata
      └──► ignored or failed job state

Agent UI ── reply to received message ──► SMTPfast ──► Internet recipient
```

Polling is the default because it works entirely on localhost. Webhook mode is available for deployments that need immediate delivery without repeated list requests. In webhook mode, the handler authenticates, validates, inserts the notification, and returns `202`; the worker performs network I/O after acknowledgement.

## Prerequisites

- Node.js 22 LTS or Node.js 24+
- Docker, or another PostgreSQL 15+ installation
- An SMTPfast plan with inbound email
- A verified sending domain

A public HTTPS URL is required only for optional webhook mode.

## Local setup

Install the application dependencies:

```bash
npm install
cp .env.example .env
```

Update `.env` with:

- `SMTPFAST_API_KEY`: a key with `inbound:read` and `email:send`
- `INBOUND_ADDRESS`: the one envelope recipient this app should turn into tickets
- `INGEST_MODE=poll`: retrieve received messages without a public endpoint
- `APP_SECRET`: at least 32 random characters for ticket-bound form tokens
- `ADMIN_USERNAME` and `ADMIN_PASSWORD`: credentials for the ticket UI

Start PostgreSQL, apply the schema, and start the application:

```bash
docker compose up -d --wait postgres
npm run db:migrate
npm run dev
```

Open `http://localhost:3000` and enter the admin credentials from `.env`.

For a UI-only local preview, insert non-sensitive sample conversations:

```bash
npm run db:seed-demo
```

The seed is idempotent and does not delete existing tickets.

## Configure SMTPfast

### 1. Enable receiving

Use a dedicated subdomain such as `inbound.example.com` if the root domain already receives normal mailbox email. Enable receiving in SMTPfast, then publish the returned MX record.

The SMTPfast MX record must be the only record at the lowest-numbered priority. A competing MX record can split traffic or take precedence.

### 2. Create a scoped API key

The worker needs:

- `inbound:read` to retrieve a received message and mint attachment links
- `email:send` to reply

It does not need domain, contact, broadcast, API-key management, or inbound-delete permissions.

### 3. Choose an ingestion mode

For the local quickstart, keep:

```dotenv
INGEST_MODE=poll
```

The worker lists the newest received messages, queues unseen SMTPfast IDs, and fetches each full message. The database uniqueness constraints make repeated polls safe. No tunnel or webhook secret is required.

For a deployed application, switch to webhook mode:

```dotenv
INGEST_MODE=webhook
SMTPFAST_WEBHOOK_SECRET=whsec_replace_me
```

Expose the local server through a trusted HTTPS development tunnel, or deploy it first. Create a standard webhook with:

```text
URL:    https://your-app.example/webhooks/smtpfast
Events: email.received
Format: standard
```

Copy the returned signing secret into `SMTPFAST_WEBHOOK_SECRET`. `APP_SECRET` remains a separate application secret.

SMTPfast retries non-2xx webhook deliveries. The retry carries the same body, so this project stores a unique event key and safely acknowledges duplicates.

## Routes

| Route | Access | Purpose |
| --- | --- | --- |
| `GET /healthz` | Public | Process liveness; does not call dependencies |
| `GET /readyz` | Public | PostgreSQL readiness |
| `POST /webhooks/smtpfast` | HMAC, webhook mode | Receive and enqueue inbound notifications |
| `GET /` | Basic auth | List recent tickets |
| `GET /tickets/:number` | Basic auth | View a threaded conversation |
| `POST /tickets/:number/reply` | Basic auth + form token | Send a threaded reply |
| `GET /attachments/:id` | Basic auth | Mint and follow a fresh HTTPS attachment URL |

## Important security choices

### The signature covers raw bytes

Parsing JSON and then serializing it again can change whitespace or property order. The webhook route configures Fastify to expose the original `Buffer`, verifies `X-SMTPfast-Signature`, and only then calls `JSON.parse`.

### The visible `To` header is not routing authority

Inbound email can be Bcc'd, forwarded, or carry a forged `To` header. The worker checks `received_for`, falling back to `envelope_to`, and ignores every other address on the catch-all domain.

### Email HTML is not rendered

Messages can contain scripts, tracking pixels, misleading links, and dangerous CSS. This demo stores and displays the plain-text body. Every value written into HTML is escaped and the UI uses a restrictive Content Security Policy.

### Attachments stay behind authorization

The database stores only attachment metadata. Clicking an attachment makes an authenticated API call to obtain a fresh, short-lived SMTPfast download URL. Never treat the filename, declared MIME type, or file contents as trusted.

### Basic authentication requires HTTPS

HTTP Basic credentials are encoded, not encrypted. Deploy the UI only behind HTTPS. For a multi-user production service, replace Basic auth with your identity provider and add per-ticket authorization.

## Delivery and threading behavior

In polling mode, the worker lists received-message metadata. In webhook mode, SMTPfast emits one `email.received` event per envelope recipient. In both cases the worker fetches the complete message by ID before storing it.

Thread resolution uses this order:

1. Find a stored `Message-ID` present in the new message's `In-Reply-To` or `References` headers.
2. Fall back to a `[Ticket #N]` marker only when the sender address matches the ticket requester.
3. Create a new ticket.

Replies use `POST /v1/emails/receiving/:id/reply`. SMTPfast adds the headers required to keep the response in the recipient's existing email thread.

## Tests

Run the fast suite:

```bash
npm test
npm run typecheck
```

The PostgreSQL integration suite is opt-in and truncates its tables before each test. Use a separate test database, never the database holding your tickets. Create it once and apply the schema:

```bash
docker compose exec postgres createdb -U tickets tickets_test

DATABASE_URL=postgres://tickets:tickets@localhost:55432/tickets_test \
  npm run db:migrate

TEST_DATABASE_URL=postgres://tickets:tickets@localhost:55432/tickets_test \
  npm run test:integration
```

It verifies queue deduplication, reference-based threading, and quarantine behavior against the real schema.

## Production extensions

This repository deliberately stays small. Before using it as a full support product, consider:

- SSO and role-based access instead of Basic auth
- Ticket assignment, state transitions, and an audit log
- Object storage if attachments must outlive SMTPfast's retention window
- An attachment scanning and content-disarm pipeline before internal distribution
- Metrics for queue age, permanent failures, webhook latency, and quarantine rate
- A dead-letter review UI and alerting for failed jobs
- Multiple workers and a dedicated process type for independent scaling

## Useful SMTPfast references

- [Inbound email API](https://smtpfa.st/docs/inbound)
- [Webhook signatures and retries](https://smtpfa.st/docs/webhooks)
- [API-key scopes](https://smtpfa.st/docs/api-keys)
