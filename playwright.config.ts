import { defineConfig } from "@playwright/test";
import { requireSafePostgresTestUrl } from "./tests/e2e/postgres-safety.mjs";

const postgresDatabaseUrl = process.env.E2E_DATABASE_URL
  ? requireSafePostgresTestUrl(process.env.E2E_DATABASE_URL)
  : null;
const postgresDeletionMode = postgresDatabaseUrl !== null;
const chromiumExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: postgresDeletionMode
    ? /(?:^|\/)postgres-data-deletion\.spec\.ts$/u
    : /(?:^|\/)(?:private-reply-flow|data-deletion)\.spec\.ts$/u,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: "line",
  use: {
    baseURL: "http://localhost:3210",
    launchOptions: chromiumExecutablePath
      ? { executablePath: chromiumExecutablePath }
      : undefined,
    permissions: ["clipboard-read", "clipboard-write"],
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm --config.verify-deps-before-run=false dev --hostname 127.0.0.1 --port 3210",
    url: "http://localhost:3210/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      E2E_FIXTURE_MODE: postgresDeletionMode ? "0" : "1",
      DATABASE_URL: postgresDatabaseUrl ?? "postgresql://fixture:fixture@127.0.0.1:1/fixture",
      APP_PASSWORD_HASH: "$argon2id$v=19$m=19456,t=2,p=1$19bws3YLfDzp8bIKLjJWRQ$g+2pZw+Xo1kSIHm9fi70Hx8v9yWFIdTaPL8UB175ITk",
      SESSION_SIGNING_KEY: Buffer.alloc(32, 13).toString("base64"),
      APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      OPENAI_API_KEY: "fixture-not-used",
      ANALYSIS_MODEL: "fixture-analysis",
      REPLY_MODEL: "fixture-reply",
      EMBEDDING_MODEL: "fixture-embedding",
    },
  },
});
