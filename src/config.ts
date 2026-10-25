import { z } from "zod";

const booleanFromString = z
  .enum(["true", "false"])
  .default("true")
  .transform((value) => value === "true");

const configSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    DATABASE_URL: z.string().min(1),
    SMTPFAST_BASE_URL: z.string().url().default("https://smtpfa.st/api/v1"),
    SMTPFAST_API_KEY: z.string().min(1),
    SMTPFAST_WEBHOOK_SECRET: z.string().min(1).optional(),
    APP_SECRET: z.string().min(32).optional(),
    INBOUND_ADDRESS: z.string().email().transform((value) => value.toLowerCase()),
    INGEST_MODE: z.enum(["poll", "webhook"]).default("poll"),
    ADMIN_USERNAME: z.string().min(1),
    ADMIN_PASSWORD: z.string().min(12),
    WORKER_ENABLED: booleanFromString,
    WORKER_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
    WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
    WORKER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(25).default(8),
  })
  .superRefine((value, context) => {
    if (value.INGEST_MODE === "webhook" && !value.SMTPFAST_WEBHOOK_SECRET) {
      context.addIssue({
        code: "custom",
        path: ["SMTPFAST_WEBHOOK_SECRET"],
        message: "SMTPFAST_WEBHOOK_SECRET is required in webhook mode",
      });
    }
    if (!value.APP_SECRET && !value.SMTPFAST_WEBHOOK_SECRET) {
      context.addIssue({
        code: "custom",
        path: ["APP_SECRET"],
        message: "APP_SECRET is required when no webhook secret is configured",
      });
    }
  });

export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  databaseUrl: string;
  smtpfastBaseUrl: string;
  smtpfastApiKey: string;
  smtpfastWebhookSecret: string | undefined;
  appSecret: string;
  inboundAddress: string;
  ingestMode: "poll" | "webhook";
  adminUsername: string;
  adminPassword: string;
  workerEnabled: boolean;
  workerPollMs: number;
  workerBatchSize: number;
  workerMaxAttempts: number;
};

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema.parse(environment);

  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL,
    smtpfastBaseUrl: parsed.SMTPFAST_BASE_URL.replace(/\/$/, ""),
    smtpfastApiKey: parsed.SMTPFAST_API_KEY,
    smtpfastWebhookSecret: parsed.SMTPFAST_WEBHOOK_SECRET,
    appSecret: parsed.APP_SECRET ?? parsed.SMTPFAST_WEBHOOK_SECRET!,
    inboundAddress: parsed.INBOUND_ADDRESS,
    ingestMode: parsed.INGEST_MODE,
    adminUsername: parsed.ADMIN_USERNAME,
    adminPassword: parsed.ADMIN_PASSWORD,
    workerEnabled: parsed.WORKER_ENABLED,
    workerPollMs: parsed.WORKER_POLL_MS,
    workerBatchSize: parsed.WORKER_BATCH_SIZE,
    workerMaxAttempts: parsed.WORKER_MAX_ATTEMPTS,
  };
}
