import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function verifyWebhookSignature(
  rawBody: Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature || !/^[a-f\d]{64}$/i.test(signature)) {
    return false;
  }

  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const supplied = Buffer.from(signature, "hex");

  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function signWebhookBody(rawBody: Buffer, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function webhookEventKey(rawBody: Buffer, providerEventId?: string): string {
  return providerEventId ?? `sha256:${createHash("sha256").update(rawBody).digest("hex")}`;
}

function safeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function verifyBasicAuthorization(
  header: string | undefined,
  expectedUsername: string,
  expectedPassword: string,
): boolean {
  if (!header?.startsWith("Basic ")) return false;

  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return false;
  }

  const separator = decoded.indexOf(":");
  if (separator === -1) return false;

  return (
    safeStringEqual(decoded.slice(0, separator), expectedUsername) &&
    safeStringEqual(decoded.slice(separator + 1), expectedPassword)
  );
}

export function createFormToken(ticketId: string, secret: string): string {
  return createHmac("sha256", secret).update(`reply:${ticketId}`).digest("hex");
}

export function verifyFormToken(ticketId: string, supplied: string, secret: string): boolean {
  return safeStringEqual(supplied, createFormToken(ticketId, secret));
}
