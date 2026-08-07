import { safeLog } from "@/lib/logger";

afterEach(() => {
  vi.restoreAllMocks();
});

test("emits an event with scalar operational metadata", () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

  safeLog("import_completed", { roomId: 42, succeeded: true, stage: "stored" });

  expect(info).toHaveBeenCalledOnce();
  expect(JSON.parse(String(info.mock.calls[0][0]))).toEqual({
    event: "import_completed",
    metadata: { roomId: 42, succeeded: true, stage: "stored" },
  });
});

test.each([
  "text",
  "lastMessageId",
  "contentType",
  "displayName",
  "profileVersion",
  "systemPromptHash",
])("rejects unsafe metadata key %s", (key) => {
  const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

  expect(() => safeLog("rejected", { [key]: "redacted" })).toThrow(
    `Unsafe log metadata key: ${key}`,
  );
  expect(info).not.toHaveBeenCalled();
});

test("rejects non-scalar metadata at runtime", () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

  expect(() => safeLog("rejected", { nested: {} } as never)).toThrow(
    "Unsafe log metadata value: nested",
  );
  expect(info).not.toHaveBeenCalled();
});
