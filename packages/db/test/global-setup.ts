import pg from "pg";
import type { TestProject } from "vitest/node";
import { runMigrations } from "../src/migrate";
import { runSeed } from "../src/seed";
import type {} from "../src/testing";

const TEST_DATABASE = "triage_test";

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

/** Recreates the test database from scratch, then migrates and seeds it exactly like `pnpm db:migrate && pnpm db:seed`. */
export default async function setup(project: TestProject) {
  const ownerUrl = process.env.DATABASE_OWNER_URL;
  const appUrl = process.env.DATABASE_URL;
  if (!ownerUrl || !appUrl) {
    throw new Error("DB tests need DATABASE_OWNER_URL and DATABASE_URL (cp .env.example .env, then pnpm infra:up)");
  }

  const admin = new pg.Client({ connectionString: withDatabase(ownerUrl, "postgres") });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DATABASE}`);
  } finally {
    await admin.end();
  }

  const urls = { ownerUrl: withDatabase(ownerUrl, TEST_DATABASE), appUrl: withDatabase(appUrl, TEST_DATABASE) };
  await runMigrations(urls);
  await runSeed(urls);
  project.provide("dbUrls", urls);
}
