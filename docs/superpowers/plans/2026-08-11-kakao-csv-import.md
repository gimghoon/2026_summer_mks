# KakaoTalk CSV Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import KakaoTalk UTF-8 `Date, User, Message` CSV exports without breaking existing text exports, and reject zero-message files before persistence.

**Architecture:** Keep `parseKakaoExport` as the public format-neutral parser. Detect the exact CSV header and delegate record decoding to a focused dependency-free CSV state machine, then normalize both formats through the existing fingerprint, import, turn, and encryption pipeline. Validate zero-message results at both the HTTP boundary and import-service boundary, and expose both file extensions in the upload UI.

**Tech Stack:** TypeScript 5.9, Next.js 15 App Router, React 19, Vitest 3, Testing Library, Drizzle ORM, Node.js 22+

## Global Constraints

- Preserve the existing Korean date-based `.txt` format.
- Support UTF-8 CSV with the exact ordered header `Date`, `User`, `Message`.
- Interpret `YYYY-MM-DD HH:mm:ss` as Asia/Seoul local time.
- Support commas, escaped double quotes, CRLF/LF, and quoted multiline messages.
- Add no CSV runtime dependency.
- Reject an input with zero valid messages before creating or updating a room.
- Do not stage, print, or modify `.env.local` or private KakaoTalk exports.
- Use only synthetic fixtures in the repository.

---

### Task 1: Parse KakaoTalk CSV records

**Files:**
- Create: `src/domain/kakao/csv-parser.ts`
- Create: `tests/fixtures/kakao/group-chat.csv`
- Modify: `src/domain/kakao/parser.ts`
- Modify: `tests/unit/kakao-parser.test.ts`

**Interfaces:**
- Produces: `isKakaoCsv(input: string): boolean`
- Produces: `parseKakaoCsv(input: string): { messages: CsvMessage[]; unparsedLines: Array<{ line: number; text: string }> }`
- `CsvMessage` is `{ sentAt: Date; speaker: string; text: string; sourceLine: number }`.
- `parseKakaoExport(input: string): ParsedKakaoExport` remains unchanged for every consumer.

- [ ] **Step 1: Add a synthetic CSV fixture**

Create `tests/fixtures/kakao/group-chat.csv` with two participants, a comma, an escaped quote, and one quoted multiline message:

```csv
Date,User,Message
2026-08-07 09:01:02,민수,"거의 다 왔어, 잠깐만"
2026-08-07 09:02:03,지훈,"그럼 ""정문""에서 봐"
2026-08-07 09:03:04,민수,"첫 줄
둘째 줄"
```

- [ ] **Step 2: Write failing CSV parser tests**

Append focused tests to `tests/unit/kakao-parser.test.ts`:

```ts
test("parses KakaoTalk Date User Message CSV with quoted content", () => {
  const parsed = parseKakaoExport(fixture("group-chat.csv"));

  expect(parsed.participants).toEqual(["민수", "지훈"]);
  expect(parsed.messages).toHaveLength(3);
  expect(parsed.messages[0]).toMatchObject({
    speaker: "민수",
    text: "거의 다 왔어, 잠깐만",
    sourceLine: 2,
    sentAt: new Date("2026-08-07T00:01:02.000Z"),
  });
  expect(parsed.messages[1]!.text).toBe("그럼 \"정문\"에서 봐");
  expect(parsed.messages[2]).toMatchObject({ text: "첫 줄\n둘째 줄", sourceLine: 4 });
  expect(parsed.unparsedLines).toEqual([]);
});

test("keeps CSV fingerprints stable and distinct for repeated records", () => {
  const raw = [
    "Date,User,Message",
    "2026-08-07 09:01:02,민수,응",
    "2026-08-07 09:01:02,민수,응",
  ].join("\n");
  const first = parseKakaoExport(raw);
  const second = parseKakaoExport(raw);

  expect(new Set(first.messages.map(({ sourceFingerprint }) => sourceFingerprint)).size).toBe(2);
  expect(first.messages.map(({ sourceFingerprint }) => sourceFingerprint)).toEqual(
    second.messages.map(({ sourceFingerprint }) => sourceFingerprint),
  );
});

test("accepts a BOM and CRLF and reports malformed CSV rows", () => {
  const raw = [
    "\uFEFFDate,User,Message",
    "2026-08-07 09:01:02,민수,안녕",
    "2026-99-07 09:01:02,민수,잘못된 날짜",
    "2026-08-07 09:03:04,,이름 없음",
  ].join("\r\n");
  const parsed = parseKakaoExport(raw);

  expect(parsed.messages).toHaveLength(1);
  expect(parsed.unparsedLines.map(({ line }) => line)).toEqual([3, 4]);
});

test("reports an unterminated quoted CSV record", () => {
  const parsed = parseKakaoExport([
    "Date,User,Message",
    "2026-08-07 09:01:02,민수,\"끝나지 않은 메시지",
  ].join("\n"));

  expect(parsed.messages).toEqual([]);
  expect(parsed.unparsedLines.map(({ line }) => line)).toEqual([2]);
});
```

- [ ] **Step 3: Run the parser tests and confirm RED**

Run:

```bash
pnpm exec vitest run tests/unit/kakao-parser.test.ts
```

Expected: the CSV assertions fail because `parseKakaoExport` currently returns zero CSV messages.

- [ ] **Step 4: Implement the bounded CSV state machine**

Create `src/domain/kakao/csv-parser.ts`. The state machine must:

```ts
export type CsvMessage = {
  sentAt: Date;
  speaker: string;
  text: string;
  sourceLine: number;
};

export function isKakaoCsv(input: string): boolean;

export function parseKakaoCsv(input: string): {
  messages: CsvMessage[];
  unparsedLines: Array<{ line: number; text: string }>;
};
```

Implement these exact parsing rules:

```ts
const CSV_HEADER = ["Date", "User", "Message"];
const CSV_DATE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
```

Walk the input one character at a time. A comma ends an unquoted field; CRLF or LF ends an unquoted record; `""` inside a quoted field becomes `"`; a newline inside a quoted field becomes part of that field and increments the physical line counter. Record `sourceLine` when the record begins. Reject a row unless it has three fields, a valid calendar date, and a nonblank user. Convert the validated local calendar components to UTC with `Date.UTC(year, month - 1, day, hour - 9, minute, second)` and verify the Korea-local components round-trip before accepting them. Add malformed rows to `unparsedLines` using their starting source line.

- [ ] **Step 5: Normalize CSV through the existing parser contract**

Modify `src/domain/kakao/parser.ts` so it removes the BOM once, detects `isKakaoCsv(normalizedInput)`, maps CSV messages through the existing `messageKind`, participant collection, and occurrence-ordinal fingerprint loop, and otherwise retains the current text parsing path. Do not infer the format from the filename.

- [ ] **Step 6: Run focused parser tests and confirm GREEN**

Run:

```bash
pnpm exec vitest run tests/unit/kakao-parser.test.ts
```

Expected: all existing TXT tests and new CSV tests pass.

- [ ] **Step 7: Commit the parser slice**

```bash
git add src/domain/kakao/csv-parser.ts src/domain/kakao/parser.ts tests/fixtures/kakao/group-chat.csv tests/unit/kakao-parser.test.ts
git commit -m "feat: parse KakaoTalk CSV exports"
```

---

### Task 2: Reject empty imports and derive CSV room titles

**Files:**
- Modify: `src/domain/imports/import-service.ts`
- Modify: `src/app/api/imports/route.ts`
- Modify: `tests/integration/import-service.test.ts`
- Modify: `tests/unit/import-route.test.ts`

**Interfaces:**
- Produces: `UnsupportedKakaoExportError extends Error` exported from `src/domain/imports/import-service.ts`.
- Consumes: the unchanged `parseKakaoExport(input)` contract from Task 1.
- The import route continues to return `ImportSummary` with HTTP 201 for valid inputs.

- [ ] **Step 1: Write failing import-service and route tests**

Add an integration test proving the transaction never begins for an empty parse:

```ts
test("rejects an unsupported export before opening an import transaction", async () => {
  const repository = new InMemoryImportRepository();
  const transaction = vi.spyOn(repository, "transaction");

  await expect(importKakaoExport({
    title: "지원하지 않는 파일",
    selfName: "지훈",
    rawText: "Date,User,Other\n2026-08-07 09:01:02,민수,안녕",
  }, repository)).rejects.toThrow("No valid KakaoTalk messages");
  expect(transaction).not.toHaveBeenCalled();
});
```

Update the multipart helper in `tests/unit/import-route.test.ts` to accept `filename` and `contentType`, then add:

```ts
test("accepts a valid CSV and removes the csv extension from the room title", async () => {
  importKakaoExportMock.mockResolvedValue({
    roomId: "11111111-1111-4111-8111-111111111111",
    insertedMessages: 1,
    duplicateMessages: 0,
    unparsedLines: [],
  });
  const csv = encoder.encode("Date,User,Message\n2026-08-07 09:01:02,민수,안녕");
  const response = await POST(await authenticatedRequest(
    multipartBody("지훈", csv, undefined, "목요일 모임.csv", "text/csv"),
  ));

  expect(response.status).toBe(201);
  expect(importKakaoExportMock).toHaveBeenCalledWith(expect.objectContaining({
    title: "목요일 모임",
    rawText: expect.stringContaining("Date,User,Message"),
  }));
});

test("returns 400 without importing when no valid messages are parsed", async () => {
  const body = multipartBody(
    "지훈",
    encoder.encode("Date,User,Other\n2026-08-07 09:01:02,민수,안녕"),
    undefined,
    "unsupported.csv",
    "text/csv",
  );
  const response = await POST(await authenticatedRequest(body));

  expect(response.status).toBe(400);
  expect(importKakaoExportMock).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the boundary tests and confirm RED**

Run:

```bash
pnpm exec vitest run tests/integration/import-service.test.ts tests/unit/import-route.test.ts
```

Expected: empty import currently opens a transaction/creates a room, CSV extension remains in the title, and the route does not reject zero messages.

- [ ] **Step 3: Add the service invariant**

In `src/domain/imports/import-service.ts`, export:

```ts
export class UnsupportedKakaoExportError extends Error {
  constructor() {
    super("No valid KakaoTalk messages");
    this.name = "UnsupportedKakaoExportError";
  }
}
```

Immediately after `const parsed = parseKakaoExport(command.rawText)`, throw this error when `parsed.messages.length === 0`. This check must remain before `repository.transaction(...)`.

- [ ] **Step 4: Add the HTTP boundary validation**

In `src/app/api/imports/route.ts`:

```ts
const title = parsed.title || file.name.replace(/\.(?:txt|csv)$/i, "");
if (parsed.messages.length === 0) {
  return Response.json(
    { error: "지원하는 카카오톡 대화 형식이 아니거나 메시지가 없어요." },
    { status: 400 },
  );
}
```

Also catch `UnsupportedKakaoExportError` around the service call and return the same 400 response so non-HTTP callers and future route refactors preserve the invariant.

- [ ] **Step 5: Run the boundary tests and confirm GREEN**

Run:

```bash
pnpm exec vitest run tests/integration/import-service.test.ts tests/unit/import-route.test.ts
```

Expected: all focused tests pass; the import mock is never called for an unsupported file.

- [ ] **Step 6: Commit the import-boundary slice**

```bash
git add src/domain/imports/import-service.ts src/app/api/imports/route.ts tests/integration/import-service.test.ts tests/unit/import-route.test.ts
git commit -m "fix: reject empty KakaoTalk imports"
```

---

### Task 3: Expose CSV upload and verify the complete flow

**Files:**
- Modify: `src/components/rooms-workspace.tsx`
- Modify: `tests/unit/rooms-workspace.test.tsx`
- Modify: `README.md`

**Interfaces:**
- Consumes: `POST /api/imports` support for `.txt` and `.csv` from Task 2.
- Produces: an upload input whose accept value is `.txt,.csv,text/plain,text/csv` and user-facing copy naming both formats.

- [ ] **Step 1: Write a failing upload-control test**

Add to `tests/unit/rooms-workspace.test.tsx`:

```tsx
test("offers both KakaoTalk txt and csv files", () => {
  render(<RoomsWorkspace initialRooms={[]} />);

  const input = screen.getByLabelText("카카오톡 파일 업로드");
  expect(input).toHaveAttribute("accept", ".txt,.csv,text/plain,text/csv");
  expect(screen.getByText("카카오톡 .txt 또는 .csv 파일 선택")).toBeVisible();
});
```

- [ ] **Step 2: Run the component test and confirm RED**

Run:

```bash
pnpm exec vitest run tests/unit/rooms-workspace.test.tsx
```

Expected: the current control accepts and labels `.txt` only.

- [ ] **Step 3: Update the upload control and error copy**

In `src/components/rooms-workspace.tsx`, change the file input to:

```tsx
<input
  type="file"
  accept=".txt,.csv,text/plain,text/csv"
  aria-label="카카오톡 파일 업로드"
  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
/>
```

Change its empty label to `카카오톡 .txt 또는 .csv 파일 선택` and the failed-import message to `대화를 가져오지 못했어요. 카카오톡 .txt 또는 .csv 파일과 내 이름을 다시 확인해 주세요.`

- [ ] **Step 4: Document accepted exports**

Add a short README upload note stating that the app accepts the current KakaoTalk `Date, User, Message` CSV export and the existing Korean date-based text export, both up to the unchanged 50 MiB file limit.

- [ ] **Step 5: Run focused and full verification**

Run sequentially:

```bash
pnpm exec vitest run tests/unit/kakao-parser.test.ts tests/unit/import-route.test.ts tests/unit/rooms-workspace.test.tsx tests/integration/import-service.test.ts
pnpm test
pnpm test:integration
pnpm exec tsc --noEmit
pnpm build
git diff --check
```

Expected: every command exits 0. Confirm `git status --short` lists only the intended Task 3 files plus the pre-existing untracked `.env.local`, which remains unstaged.

- [ ] **Step 6: Perform a privacy-safe real-file smoke parse**

Run a local script that reads the user-supplied CSV and prints counts only—never names or message text. Expected result: more than zero messages, more than zero participants, and no parser exception.

- [ ] **Step 7: Commit the UI and documentation slice**

```bash
git add src/components/rooms-workspace.tsx tests/unit/rooms-workspace.test.tsx README.md
git commit -m "feat: expose KakaoTalk CSV uploads"
```

- [ ] **Step 8: Review deployment handoff**

Confirm the branch contains the three implementation commits after design/plan commits, then report the exact Render redeploy action: push `main`, let Render run migrations/build, upload the original `.csv`, and verify the import response reports a positive `insertedMessages` count before starting analysis.
