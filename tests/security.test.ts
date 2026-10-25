import { describe, expect, it } from "vitest";
import {
  createFormToken,
  signWebhookBody,
  verifyBasicAuthorization,
  verifyFormToken,
  verifyWebhookSignature,
  webhookEventKey,
} from "../src/lib/security.js";

describe("webhook security", () => {
  it("verifies the exact raw bytes with HMAC-SHA256", () => {
    const body = Buffer.from('{"type":"email.received"}');
    const signature = signWebhookBody(body, "secret");

    expect(verifyWebhookSignature(body, signature, "secret")).toBe(true);
    expect(verifyWebhookSignature(Buffer.from('{ "type":"email.received"}'), signature, "secret")).toBe(
      false,
    );
  });

  it("rejects missing and malformed signatures without throwing", () => {
    const body = Buffer.from("{}");
    expect(verifyWebhookSignature(body, undefined, "secret")).toBe(false);
    expect(verifyWebhookSignature(body, "not-hex", "secret")).toBe(false);
  });

  it("uses a provider event id or a stable body hash for deduplication", () => {
    const body = Buffer.from("same body");
    expect(webhookEventKey(body, "evt_123")).toBe("evt_123");
    expect(webhookEventKey(body)).toBe(webhookEventKey(body));
  });
});

describe("admin security", () => {
  it("checks HTTP Basic credentials", () => {
    const header = `Basic ${Buffer.from("admin:correct horse battery staple").toString("base64")}`;
    expect(verifyBasicAuthorization(header, "admin", "correct horse battery staple")).toBe(true);
    expect(verifyBasicAuthorization(header, "admin", "wrong password")).toBe(false);
  });

  it("creates ticket-bound reply tokens", () => {
    const token = createFormToken("ticket-a", "secret");
    expect(verifyFormToken("ticket-a", token, "secret")).toBe(true);
    expect(verifyFormToken("ticket-b", token, "secret")).toBe(false);
  });
});
