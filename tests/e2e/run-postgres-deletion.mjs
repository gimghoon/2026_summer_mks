import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { requireSafePostgresTestUrl } from "./postgres-safety.mjs";

const databaseUrl = requireSafePostgresTestUrl(process.env.E2E_DATABASE_URL);
const executableSuffix = process.platform === "win32" ? ".cmd" : "";

function run(binary, args, environment) {
  const result = spawnSync(binary, args, {
    env: environment,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(
  resolve(`node_modules/.bin/drizzle-kit${executableSuffix}`),
  ["migrate"],
  { ...process.env, DATABASE_URL: databaseUrl },
);
run(
  resolve(`node_modules/.bin/playwright${executableSuffix}`),
  ["test", "tests/e2e/postgres-data-deletion.spec.ts"],
  { ...process.env, E2E_DATABASE_URL: databaseUrl, E2E_FIXTURE_MODE: "0" },
);
