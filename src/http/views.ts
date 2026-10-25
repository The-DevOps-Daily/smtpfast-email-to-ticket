import type { TicketDetail, TicketSummary } from "../domain.js";
import { escapeHtml, formatBytes, formatTimestamp } from "../lib/html.js";

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)} · Mailroom</title>
    <link rel="stylesheet" href="/assets/styles.css">
  </head>
  <body>
    <header class="site-header">
      <a class="brand" href="/"><span class="brand-mark">M</span> Mailroom</a>
      <span class="header-label">Inbound email, made visible</span>
    </header>
    <main>${body}</main>
  </body>
</html>`;
}

function statusBadge(status: TicketSummary["status"]): string {
  return `<span class="status status-${status}">${escapeHtml(status)}</span>`;
}

export function renderTicketList(tickets: TicketSummary[], inboundAddress: string): string {
  const rows = tickets
    .map(
      (ticket) => `<a class="ticket-row" href="/tickets/${ticket.number}">
        <div class="ticket-number">#${ticket.number}</div>
        <div class="ticket-main">
          <div class="ticket-subject">${escapeHtml(ticket.subject)}</div>
          <div class="ticket-meta">${escapeHtml(ticket.requesterLabel)} · ${escapeHtml(ticket.requesterEmail)}</div>
        </div>
        <div class="ticket-count">${ticket.messageCount} ${ticket.messageCount === 1 ? "message" : "messages"}</div>
        <time>${escapeHtml(formatTimestamp(ticket.lastMessageAt))}</time>
        ${statusBadge(ticket.status)}
      </a>`,
    )
    .join("");

  return layout(
    "Tickets",
    `<section class="hero">
      <div>
        <p class="eyebrow">EMAIL-TO-TICKET PIPELINE</p>
        <h1>Customer conversations</h1>
        <p>Messages addressed to <strong>${escapeHtml(inboundAddress)}</strong> become durable, threaded tickets.</p>
      </div>
      <div class="hero-stat"><strong>${tickets.length}</strong><span>visible tickets</span></div>
    </section>
    <section class="panel">
      <div class="panel-heading"><h2>Inbox</h2><span>Newest activity first</span></div>
      <div class="ticket-list">${rows || '<div class="empty">No tickets yet. Send an email to the inbound address.</div>'}</div>
    </section>`,
  );
}

export function renderTicket(ticket: TicketDetail, formToken: string): string {
  const messages = ticket.messages
    .map((message) => {
      const verdicts = Object.entries(message.verdicts)
        .map(
          ([name, value]) =>
            `<span class="verdict ${value.toUpperCase() === "PASS" ? "verdict-pass" : "verdict-warn"}">${escapeHtml(name.toUpperCase())}: ${escapeHtml(value)}</span>`,
        )
        .join("");
      const attachments = message.attachments
        .map(
          (attachment) => `<a class="attachment" href="/attachments/${attachment.id}">
            <span>↧</span><span>${escapeHtml(attachment.filename)}<small>${escapeHtml(attachment.contentType)} · ${formatBytes(attachment.sizeBytes)}</small></span>
          </a>`,
        )
        .join("");

      return `<article class="message message-${message.direction}">
        <div class="message-head">
          <div><span class="direction">${message.direction}</span><strong>${escapeHtml(message.fromHeader)}</strong></div>
          <time>${escapeHtml(formatTimestamp(message.receivedAt))}</time>
        </div>
        <div class="message-subject">${escapeHtml(message.subject)}</div>
        ${
          message.quarantined
            ? '<div class="quarantine"><strong>Content quarantined</strong><br>The provider did not expose this message body or its attachments because the virus verdict did not pass.</div>'
            : `<pre class="message-body">${escapeHtml(message.textBody ?? "(No plain-text body was supplied.)")}</pre>`
        }
        ${verdicts ? `<div class="verdicts">${verdicts}</div>` : ""}
        ${attachments ? `<div class="attachments">${attachments}</div>` : ""}
      </article>`;
    })
    .join("");

  const lastInbound = [...ticket.messages].reverse().find((message) => message.direction === "inbound");
  const canReply = lastInbound && !lastInbound.quarantined;

  return layout(
    `Ticket #${ticket.number}`,
    `<nav class="breadcrumb"><a href="/">← All tickets</a></nav>
    <section class="ticket-header">
      <div>
        <div class="ticket-kicker">Ticket #${ticket.number} ${statusBadge(ticket.status)}</div>
        <h1>${escapeHtml(ticket.subject)}</h1>
        <p>${escapeHtml(ticket.requesterLabel)} · ${escapeHtml(ticket.requesterEmail)}</p>
      </div>
      <div class="mailbox"><span>Delivered to</span><strong>${escapeHtml(ticket.mailbox)}</strong></div>
    </section>
    <section class="conversation">${messages}</section>
    <section class="reply-panel">
      <h2>Reply</h2>
      ${
        canReply
          ? `<form method="post" action="/tickets/${ticket.number}/reply">
              <input type="hidden" name="csrf" value="${escapeHtml(formToken)}">
              <label class="sr-only" for="reply-text">Plain-text reply</label>
              <textarea id="reply-text" name="text" maxlength="10000" required placeholder="Write a plain-text reply…"></textarea>
              <div class="reply-actions"><span>SMTPfast preserves the email thread.</span><button type="submit">Send reply</button></div>
            </form>`
          : '<p class="empty">A quarantined ticket cannot be replied to.</p>'
      }
    </section>`,
  );
}
