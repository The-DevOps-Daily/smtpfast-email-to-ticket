import type { InboundMailClient } from "../domain.js";
import {
  receivedAttachmentSchema,
  receivedEmailSchema,
  receivedEmailListSchema,
  type ReceivedAttachment,
  type ReceivedEmail,
  type ReceivedEmailSummary,
} from "./types.js";

export class SmtpfastApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "SmtpfastApiError";
  }
}

export class SmtpfastClient implements InboundMailClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async listReceivedEmails(limit = 100): Promise<ReceivedEmailSummary[]> {
    const boundedLimit = Math.max(1, Math.min(100, limit));
    const payload = await this.request(`/emails/receiving?limit=${boundedLimit}`);
    return receivedEmailListSchema.parse(payload).data;
  }

  async getReceivedEmail(id: string): Promise<ReceivedEmail> {
    const payload = await this.request(`/emails/receiving/${encodeURIComponent(id)}`);
    return receivedEmailSchema.parse(payload);
  }

  async getReceivedAttachment(
    receivedId: string,
    attachmentId: string,
  ): Promise<ReceivedAttachment> {
    const payload = await this.request(
      `/emails/receiving/${encodeURIComponent(receivedId)}/attachments/${encodeURIComponent(attachmentId)}`,
    );
    return receivedAttachmentSchema.parse(payload);
  }

  async replyToReceivedEmail(
    receivedId: string,
    body: { subject?: string; text: string },
  ): Promise<{ id: string }> {
    const payload = await this.request(`/emails/receiving/${encodeURIComponent(receivedId)}/reply`, {
      method: "POST",
      body: JSON.stringify(body),
    });

    if (
      typeof payload !== "object" ||
      payload === null ||
      !("id" in payload) ||
      typeof payload.id !== "string"
    ) {
      throw new SmtpfastApiError("SMTPfast returned an invalid reply response", 502, true);
    }

    return { id: payload.id };
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;

    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(10_000),
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...init.headers,
        },
      });
    } catch (error) {
      throw new SmtpfastApiError(
        error instanceof Error ? error.message : "SMTPfast request failed",
        503,
        true,
      );
    }

    const text = await response.text();
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const detail =
        typeof payload === "object" && payload !== null && "error" in payload
          ? String(payload.error)
          : `SMTPfast returned HTTP ${response.status}`;
      throw new SmtpfastApiError(
        detail,
        response.status,
        response.status === 408 || response.status === 429 || response.status >= 500,
      );
    }

    return payload;
  }
}
