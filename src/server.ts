import "dotenv/config";
import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { PostgresTicketStore } from "./db/store.js";
import { buildApp } from "./http/app.js";
import { SmtpfastClient } from "./smtpfast/client.js";
import { InboundWorker } from "./worker/inbound-worker.js";

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const store = new PostgresTicketStore(pool);
const mailClient = new SmtpfastClient(config.smtpfastBaseUrl, config.smtpfastApiKey);
const app = buildApp({ config, store, mailClient });
const worker = new InboundWorker(config, store, mailClient, app.log);

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "Shutting down");
  worker.stop();
  await app.close();
  await pool.end();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: config.host, port: config.port });
  if (config.workerEnabled) worker.start();
} catch (error) {
  app.log.error({ error }, "Could not start the server");
  await pool.end();
  process.exitCode = 1;
}
