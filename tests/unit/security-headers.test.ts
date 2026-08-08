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
