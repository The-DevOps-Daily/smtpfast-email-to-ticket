import formbody from "@fastify/formbody";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { resolve } from "node:path";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { InboundMailClient, TicketStore } from "../domain.js";
import { subjectWithTicketNumber } from "../lib/email.js";
import {
  createFormToken,
  verifyBasicAuthorization,
  verifyFormToken,
  verifyWebhookSignature,
  webhookEventKey,
} from "../lib/security.js";
import { smtpfastWebhookEventSchema } from "../smtpfast/types.js";
import { renderTicket, renderTicketList } from "./views.js";

type AppDependencies = {
  config: AppConfig;
  store: TicketStore;
  mailClient: InboundMailClient;
};

const eventEnvelopeSchema = z.object({ type: z.string() }).passthrough();
const ticketParamsSchema = z.object({ ticketNumber: z.string().regex(/^\d+$/) });
const attachmentParamsSchema = z.object({ attachmentId: z.string().uuid() });
const replyBodySchema = z.object({
  text: z.string().trim().min(1).max(10_000),
  csrf: z.string().length(64),
});

export function buildApp({ config, store, mailClient }: AppDependencies) {
  const app = Fastify({
    logger: config.nodeEnv !== "test",
    bodyLimit: 1_048_576,
    trustProxy: true,
  });

  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );

  app.register(formbody);
  app.register(fastifyStatic, {
    root: resolve(process.cwd(), "public"),
    prefix: "/assets/",
    decorateReply: false,
  });

  app.addHook("onSend", async (_request, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("X-Frame-Options", "DENY")
      .header("Referrer-Policy", "no-referrer")
      .header(
        "Content-Security-Policy",
        "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      );
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/readyz", async (_request, reply) => {
    try {
      await store.ping();
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });

  app.post("/webhooks/smtpfast", async (request, reply) => {
    if (!config.smtpfastWebhookSecret) {
      return reply.code(404).send({ error: "Webhook ingestion is not configured" });
    }
    const rawBody = request.body;
    if (!Buffer.isBuffer(rawBody)) {
      return reply.code(415).send({ error: "Expected application/json" });
    }

    const signature = headerValue(request.headers["x-smtpfast-signature"]);
    if (!verifyWebhookSignature(rawBody, signature, config.smtpfastWebhookSecret)) {
      return reply.code(401).send({ error: "Invalid webhook signature" });
    }

    let untrustedPayload: unknown;
    try {
      untrustedPayload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return reply.code(400).send({ error: "Invalid JSON" });
    }

    const envelope = eventEnvelopeSchema.safeParse(untrustedPayload);
    if (!envelope.success) {
      return reply.code(400).send({ error: "Invalid webhook event" });
    }
    if (envelope.data.type !== "email.received") {
      return reply.code(204).send();
    }

    const parsed = smtpfastWebhookEventSchema.safeParse(untrustedPayload);
    if (!parsed.success) {
      request.log.warn({ issues: parsed.error.issues }, "Rejected malformed inbound event");
      return reply.code(400).send({ error: "Invalid email.received payload" });
    }

    const eventKey = webhookEventKey(rawBody, parsed.data.id);
    const inserted = await store.enqueueInboundJob(eventKey, parsed.data.data.id, parsed.data);

    return reply.code(202).send({ accepted: true, duplicate: !inserted });
  });

  app.get("/", async (request, reply) => {
    if (!requireAdmin(request, reply, config)) return;
    const tickets = await store.listTickets();
    return reply.type("text/html; charset=utf-8").send(renderTicketList(tickets, config.inboundAddress));
  });

  app.get("/tickets/:ticketNumber", async (request, reply) => {
    if (!requireAdmin(request, reply, config)) return;
    const params = ticketParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send("Not found");

    const ticket = await store.getTicket(params.data.ticketNumber);
    if (!ticket) return reply.code(404).send("Ticket not found");
    const token = createFormToken(ticket.id, config.appSecret);
    return reply.type("text/html; charset=utf-8").send(renderTicket(ticket, token));
  });

  app.post("/tickets/:ticketNumber/reply", async (request, reply) => {
    if (!requireAdmin(request, reply, config)) return;
    const params = ticketParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send("Not found");

    const body = replyBodySchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send("A reply between 1 and 10,000 characters is required");

    const ticket = await store.getTicket(params.data.ticketNumber);
    if (!ticket) return reply.code(404).send("Ticket not found");
    if (!verifyFormToken(ticket.id, body.data.csrf, config.appSecret)) {
      return reply.code(403).send("Invalid form token");
    }

    const lastInbound = [...ticket.messages]
      .reverse()
      .find((message) => message.direction === "inbound" && message.smtpfastReceivedId);
    if (!lastInbound?.smtpfastReceivedId || lastInbound.quarantined) {
      return reply.code(409).send("This ticket does not have a replyable inbound message");
    }

    const subject = subjectWithTicketNumber(ticket.number, ticket.subject);
    const sent = await mailClient.replyToReceivedEmail(lastInbound.smtpfastReceivedId, {
      subject,
      text: body.data.text,
    });
    await store.recordOutboundReply({
      ticketId: ticket.id,
      smtpfastEmailId: sent.id,
      inReplyToReceivedId: lastInbound.smtpfastReceivedId,
      fromHeader: ticket.mailbox,
      toHeaders: [ticket.requesterEmail],
      subject,
      textBody: body.data.text,
    });

    return reply.code(303).redirect(`/tickets/${ticket.number}`);
  });

  app.get("/attachments/:attachmentId", async (request, reply) => {
    if (!requireAdmin(request, reply, config)) return;
    const params = attachmentParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send("Not found");

    const target = await store.getAttachmentTarget(params.data.attachmentId);
    if (!target) return reply.code(404).send("Attachment not found");
    const attachment = await mailClient.getReceivedAttachment(
      target.smtpfastReceivedId,
      target.smtpfastAttachmentId,
    );
    if (!attachment.download_url) {
      return reply.code(502).send("SMTPfast did not return a download URL");
    }

    const downloadUrl = new URL(attachment.download_url);
    if (downloadUrl.protocol !== "https:") {
      request.log.error({ downloadUrl: attachment.download_url }, "Rejected non-HTTPS attachment URL");
      return reply.code(502).send("Invalid attachment URL");
    }
    return reply.redirect(downloadUrl.toString());
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ error }, "Request failed");
    if (request.url.startsWith("/webhooks/")) {
      return reply.code(503).send({ error: "Webhook processing unavailable" });
    }
    return reply.code(500).send("The request could not be completed");
  });

  return app;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  config: Pick<AppConfig, "adminUsername" | "adminPassword">,
): boolean {
  if (
    verifyBasicAuthorization(
      request.headers.authorization,
      config.adminUsername,
      config.adminPassword,
    )
  ) {
    return true;
  }

  reply.header("WWW-Authenticate", 'Basic realm="Mailroom", charset="UTF-8"').code(401).send("Authentication required");
  return false;
}
