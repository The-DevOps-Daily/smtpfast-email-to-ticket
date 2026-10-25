import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/http/app.js";
import { signWebhookBody } from "../src/lib/security.js";
import { FakeMailClient, FakeStore, testConfig, webhookEvent } from "./helpers.js";

const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("POST /webhooks/smtpfast", () => {
  it("authenticates and durably enqueues an inbound notification", async () => {
    const store = new FakeStore();
    const app = buildApp({ config: testConfig, store, mailClient: new FakeMailClient() });
    apps.push(app);
    const body = JSON.stringify(webhookEvent());

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/smtpfast",
      headers: {
        "content-type": "application/json",
        "x-smtpfast-signature": signWebhookBody(Buffer.from(body), testConfig.smtpfastWebhookSecret!),
      },
      payload: body,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: true, duplicate: false });
    expect(store.jobs).toHaveLength(1);
    expect(store.jobs[0]?.smtpfastReceivedId).toBe("rcv_01test");
  });

  it("acknowledges a signed retry without creating a second job", async () => {
    const store = new FakeStore();
    const app = buildApp({ config: testConfig, store, mailClient: new FakeMailClient() });
    apps.push(app);
    const body = JSON.stringify(webhookEvent());
    const headers = {
      "content-type": "application/json",
      "x-smtpfast-signature": signWebhookBody(Buffer.from(body), testConfig.smtpfastWebhookSecret!),
    };

    await app.inject({ method: "POST", url: "/webhooks/smtpfast", headers, payload: body });
    const retry = await app.inject({
      method: "POST",
      url: "/webhooks/smtpfast",
      headers,
      payload: body,
    });

    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toEqual({ accepted: true, duplicate: true });
    expect(store.jobs).toHaveLength(1);
  });

  it("rejects a forged webhook before parsing its contents", async () => {
    const store = new FakeStore();
    const app = buildApp({ config: testConfig, store, mailClient: new FakeMailClient() });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/smtpfast",
      headers: { "content-type": "application/json", "x-smtpfast-signature": "0".repeat(64) },
      payload: JSON.stringify(webhookEvent()),
    });

    expect(response.statusCode).toBe(401);
    expect(store.jobs).toHaveLength(0);
  });
});

describe("admin UI", () => {
  it("does not expose ticket data without authentication", async () => {
    const app = buildApp({
      config: testConfig,
      store: new FakeStore(),
      mailClient: new FakeMailClient(),
    });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toContain("Mailroom");
  });
});
