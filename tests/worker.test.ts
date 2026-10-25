import { describe, expect, it } from "vitest";
import { SmtpfastApiError } from "../src/smtpfast/client.js";
import { InboundWorker } from "../src/worker/inbound-worker.js";
import {
  FakeMailClient,
  FakeStore,
  receivedEmail,
  testConfig,
  webhookEvent,
} from "./helpers.js";

const logger = { info() {}, error() {} };

function pendingStore(): FakeStore {
  const store = new FakeStore();
  store.jobs.push({
    id: "job_01test",
    eventKey: "evt_01test",
    smtpfastReceivedId: "rcv_01test",
    payload: webhookEvent(),
    attempts: 1,
  });
  return store;
}

describe("InboundWorker", () => {
  it("polls SMTPfast and processes newly discovered messages", async () => {
    const store = new FakeStore();
    const client = new FakeMailClient();
    const worker = new InboundWorker(
      { ...testConfig, ingestMode: "poll" },
      store,
      client,
      logger,
    );

    expect(await worker.runOnce()).toBe(1);
    expect(store.saved).toHaveLength(1);
    expect(store.saved[0]?.message.id).toBe(receivedEmail.id);
    expect(await worker.runOnce()).toBe(0);
    expect(store.saved).toHaveLength(1);
  });

  it("routes by the SMTP envelope and stores a clean message", async () => {
    const store = pendingStore();
    const client = new FakeMailClient();
    const worker = new InboundWorker(testConfig, store, client, logger);

    expect(await worker.runOnce()).toBe(1);
    expect(store.saved).toHaveLength(1);
    expect(store.saved[0]?.requesterEmail).toBe("ada@example.net");
    expect(store.saved[0]?.mailbox).toBe(testConfig.inboundAddress);
  });

  it("ignores catch-all mail for another local address", async () => {
    const store = pendingStore();
    const client = new FakeMailClient();
    client.message = {
      ...receivedEmail,
      to: [testConfig.inboundAddress],
      received_for: ["invoices@inbound.example.com"],
      envelope_to: ["invoices@inbound.example.com"],
    };
    const worker = new InboundWorker(testConfig, store, client, logger);

    await worker.runOnce();
    expect(store.saved).toHaveLength(0);
    expect(store.ignored).toHaveLength(1);
  });

  it("retries transient provider failures with backoff", async () => {
    const store = pendingStore();
    const client = new FakeMailClient();
    client.error = new SmtpfastApiError("Temporarily unavailable", 503, true);
    const worker = new InboundWorker(testConfig, store, client, logger);

    await worker.runOnce();
    expect(store.rescheduled).toHaveLength(1);
    expect(store.failed).toHaveLength(0);
  });

  it("does not retry permanent provider errors", async () => {
    const store = pendingStore();
    const client = new FakeMailClient();
    client.error = new SmtpfastApiError("Not found", 404, false);
    const worker = new InboundWorker(testConfig, store, client, logger);

    await worker.runOnce();
    expect(store.rescheduled).toHaveLength(0);
    expect(store.failed).toHaveLength(1);
  });
});
