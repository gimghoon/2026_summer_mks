// @vitest-environment node

import { spawnSync } from "node:child_process";

test("the documented production start command invokes Next production mode", () => {
  const result = spawnSync("pnpm", ["start", "--help"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  expect(result.status, result.stderr).toBe(0);
  expect(`${result.stdout}\n${result.stderr}`).toContain("Usage: next start");
});
