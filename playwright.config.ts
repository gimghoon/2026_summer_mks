import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:3210",
    permissions: ["clipboard-read", "clipboard-write"],
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm --config.verify-deps-before-run=false dev --hostname 127.0.0.1 --port 3210",
    url: "http://127.0.0.1:3210/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      E2E_FIXTURE_MODE: "1",
      DATABASE_URL: "postgresql://fixture:fixture@127.0.0.1:1/fixture",
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
