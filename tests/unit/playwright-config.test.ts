import config from "../../playwright.config";

test("uses Next's localhost origin while binding the E2E server to loopback", () => {
  expect(config.use?.baseURL).toBe("http://localhost:3210");

  const webServer = Array.isArray(config.webServer)
    ? config.webServer[0]
    : config.webServer;
  expect(webServer).toMatchObject({
    command: expect.stringContaining("--hostname 127.0.0.1"),
    url: "http://localhost:3210/api/health",
  });
});
