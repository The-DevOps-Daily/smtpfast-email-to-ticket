import "dotenv/config";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createPool } from "./pool.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to run migrations");
}
const pool = createPool(databaseUrl);

try {
  const sql = await readFile(resolve(process.cwd(), "sql/001_init.sql"), "utf8");
  await pool.query(sql);
  console.log("Database migration complete");
} finally {
  await pool.end();
}
