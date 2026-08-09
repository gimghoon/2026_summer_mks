import { readFileSync } from "node:fs";
import { join } from "node:path";

import nextConfig from "../../next.config";

test("applies private-app browser security headers", async () => {
  const configured = await nextConfig.headers?.();
  const headers = Object.fromEntries((configured?.[0]?.headers ?? []).map((header) => [header.key, header.value]));

  expect(headers["Content-Security-Policy"]).toContain("default-src 'self'");
  expect(headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
  expect(headers["X-Content-Type-Options"]).toBe("nosniff");
  expect(headers["X-Frame-Options"]).toBe("DENY");
  expect(headers["Referrer-Policy"]).toBe("no-referrer");
  expect(headers["Permissions-Policy"]).toContain("camera=()");
});

test("documents forwarded request headers for every Nginx proxy location", () => {
  const runbook = readFileSync(join(process.cwd(), "docs/operations/private-deployment.md"), "utf8");
  expect(runbook).toContain("proxy_set_header Host $host;");
  expect(runbook).toContain("proxy_set_header X-Forwarded-Host $host;");
  expect(runbook).toContain("proxy_set_header X-Forwarded-Proto $scheme;");
  expect(runbook).toContain("proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;");

  const locations = runbook.match(/location (?:= \/api\/session|\/api\/|\/) \{[\s\S]*?\n  \}/gu) ?? [];
  expect(locations).toHaveLength(3);
  expect(locations.every((location) => (
    location.includes("include /etc/nginx/snippets/private-reply-proxy.conf;")
  ))).toBe(true);
});
