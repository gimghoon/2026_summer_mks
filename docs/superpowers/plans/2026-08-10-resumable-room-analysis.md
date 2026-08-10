# Resumable Room Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve each successful conversation-chunk analysis, resume only unfinished work after failure, and show privacy-safe real progress in the room UI.

**Architecture:** A dedicated PostgreSQL connection holds a session advisory lock for one room while model work runs outside long transactions. Chunk analysis and embedding are checkpointed independently as encrypted `prepared` payloads; hierarchy/profile/room-memory writes are planned after all chunks are prepared and committed atomically in one short final transaction. A room-analysis run row exposes scalar progress and stable failure codes to authenticated polling clients.

**Tech Stack:** Next.js 15 App Router, TypeScript 5.9, PostgreSQL 17, Drizzle ORM 0.44, OpenAI SDK 5, Zod 4, Vitest 3, React Testing Library.

## Global Constraints

- Never log conversation text, prompts, model responses, profile values, or participant names.
- Reuse a prepared chunk only when its current source fingerprint and analysis key match the stored payload.
- Same-room analysis must be serialized across processes.
- Profile replacement, room-memory replacement, and final chunk completion markers must commit atomically.
- Client errors remain generic; operational logs and status responses contain scalar progress and predefined failure codes only.
- No external queue, cancellation feature, cost estimator, or billing integration is added.

---

## File Structure

- `src/db/schema.ts`: declares persisted room-analysis run state.
- `src/db/migrations/0002_room_analysis_runs.sql`: creates the run table and constraints.
- `src/domain/memory/analysis-progress.ts`: owns status types, safe failure classification, and the Drizzle progress repository.
- `src/domain/memory/extractor.ts`: separates reusable chunk preparation, hierarchy planning, and atomic finalization inputs.
- `src/domain/memory/room-analysis-orchestrator.ts`: holds the dedicated room lock and coordinates short transactions.
- `src/db/client.ts`: exposes a dedicated Drizzle connection with guaranteed release.
- `src/app/api/rooms/[roomId]/analysis/route.ts`: supports authenticated POST and GET progress boundaries.
- `src/components/room-analysis-actions.tsx`: starts analysis, polls progress, and renders real chunk counts.
- `src/components/rooms-workspace.tsx`: redirects an imported room into the shared analysis UI instead of showing fixed 45/65 analysis progress.
- `src/domain/models/openai-gateway.ts`: uses Zod 4 native JSON Schema conversion.

---

### Task 1: Finalize Zod 4 Structured Output Compatibility

**Files:**
- Modify: `src/domain/models/openai-gateway.ts`
- Modify: `tests/unit/model-gateway.test.ts`

**Interfaces:**
- Consumes: `StructuredModelRequest<T>` from `src/domain/models/gateway.ts`.
- Produces: strict Responses API format `{ type: "json_schema", name, strict: true, schema }` whose root schema is an object for object Zod schemas.

- [ ] **Step 1: Keep the failing regression assertion**

```ts
const format = responsesCreate.mock.calls[0]![0].text?.format;
expect(format).toMatchObject({
  type: "json_schema",
  schema: {
    type: "object",
    properties: { topic: { type: "string" } },
    required: ["topic"],
  },
});
```

- [ ] **Step 2: Verify the legacy helper fails the regression**

Run: `pnpm exec vitest run tests/unit/model-gateway.test.ts`

Expected: FAIL because `zodTextFormat` emits `schema.type: "string"` with Zod 4.

- [ ] **Step 3: Use Zod 4 native JSON Schema conversion**

```ts
import { z } from "zod";

format: {
  type: "json_schema",
  name: request.schemaName,
  strict: true,
  schema: z.toJSONSchema(request.schema, { target: "draft-7" }),
}
```

- [ ] **Step 4: Verify gateway tests and types**

Run: `pnpm exec vitest run tests/unit/model-gateway.test.ts && pnpm exec tsc --noEmit`

Expected: 12 gateway tests PASS and TypeScript exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/domain/models/openai-gateway.ts tests/unit/model-gateway.test.ts
git commit -m "fix: emit valid structured output schemas"
```

---

### Task 2: Persist Privacy-Safe Analysis Run State

**Files:**
- Modify: `src/db/schema.ts`
- Create: `src/db/migrations/0002_room_analysis_runs.sql`
- Create: `src/domain/memory/analysis-progress.ts`
- Create: `tests/integration/analysis-progress.test.ts`
- Modify: `tests/unit/schema-contract.test.ts`

**Interfaces:**
- Produces:

```ts
export type AnalysisRunStatus = "pending" | "analyzing" | "finalizing" | "ready" | "failed";
export type AnalysisStage = "chunks" | "hierarchy" | "profiles" | "complete";
export type AnalysisFailureCode =
  | "none"
  | "provider_rejected"
  | "provider_unavailable"
  | "model_validation"
  | "evidence_validation"
  | "hierarchy_validation"
  | "database"
  | "unexpected";

export type AnalysisProgress = {
  roomId: string;
  status: AnalysisRunStatus;
  stage: AnalysisStage;
  completedChunks: number;
  totalChunks: number;
  failure: AnalysisFailureCode;
};

export interface AnalysisProgressRepository {
  start(roomId: string, totalChunks: number): Promise<void>;
  recordChunk(roomId: string, completedChunks: number): Promise<void>;
  finalizing(roomId: string, stage: "hierarchy" | "profiles"): Promise<void>;
  ready(roomId: string): Promise<void>;
  failed(roomId: string, failure: AnalysisFailureCode): Promise<void>;
  get(roomId: string): Promise<AnalysisProgress | null>;
}
```

- [ ] **Step 1: Write failing state and privacy tests**

```ts
test("persists scalar progress and overwrites a failed run on retry", async () => {
  await repository.start(roomId, 3);
  await repository.recordChunk(roomId, 1);
  await repository.failed(roomId, "model_validation");
  expect(await repository.get(roomId)).toMatchObject({
    status: "failed", completedChunks: 1, totalChunks: 3,
    failure: "model_validation",
  });
  await repository.start(roomId, 3);
  expect(await repository.get(roomId)).toMatchObject({
    status: "analyzing", completedChunks: 1, failure: "none",
  });
});

test("classifies provider and semantic failures without retaining messages", () => {
  expect(classifyAnalysisFailure(Object.assign(new Error("private"), { status: 429 })))
    .toBe("provider_unavailable");
  expect(classifyAnalysisFailure(new ModelResponseValidationError()))
    .toBe("model_validation");
});
```

- [ ] **Step 2: Run tests to verify missing schema and repository fail**

Run: `pnpm exec vitest run tests/integration/analysis-progress.test.ts tests/unit/schema-contract.test.ts`

Expected: FAIL because `roomAnalysisRuns` and repository exports do not exist.

- [ ] **Step 3: Add the table and migration**

```ts
export const roomAnalysisRuns = pgTable("room_analysis_runs", {
  roomId: uuid("room_id").primaryKey().references(() => rooms.id, { onDelete: "cascade" }),
  status: text("status").notNull(),
  stage: text("stage").notNull(),
  completedChunks: integer("completed_chunks").notNull().default(0),
  totalChunks: integer("total_chunks").notNull().default(0),
  failure: text("failure").notNull().default("none"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
```

The SQL migration must create the table, non-negative/count-order checks, status/stage/failure enum-like checks, and `ON DELETE CASCADE` to `rooms(id)`.

- [ ] **Step 4: Implement repository upserts and stable classification**

Use `INSERT ... ON CONFLICT (room_id) DO UPDATE` for `start`. Preserve `completed_chunks` only up to the new total and clear the previous failure. Every other update must include `room_id` in its predicate. `classifyAnalysisFailure` must inspect error class/status/code but never return or store `error.message`.

- [ ] **Step 5: Verify migration, schema, and repository**

Run: `pnpm exec vitest run tests/integration/analysis-progress.test.ts tests/unit/schema-contract.test.ts && pnpm exec drizzle-kit check --config=drizzle.config.ts`

Expected: tests PASS and Drizzle reports the schema is valid.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts src/db/migrations/0002_room_analysis_runs.sql src/domain/memory/analysis-progress.ts tests/integration/analysis-progress.test.ts tests/unit/schema-contract.test.ts
git commit -m "feat: persist room analysis progress"
```

---

### Task 3: Checkpoint Prepared Chunks and Resume Finalization

**Files:**
- Modify: `src/domain/memory/extractor.ts`
- Modify: `tests/integration/profile-service.test.ts`
- Create: `tests/integration/resumable-memory-extractor.test.ts`

**Interfaces:**
- Produces:

```ts
export type PreparedRoomAnalysis = {
  roomId: string;
  analysisKeys: string[];
  profileOperations: AiProfileFact[];
  topicMemory: RoomMemoryPayload;
  chunkIds: string[];
};

export async function prepareRoomChunks(
  roomId: string,
  dependencies: MemoryExtractorDependencies,
  onPrepared: (completed: number, total: number) => Promise<void>,
): Promise<{ prepared: number; total: number }>;

export async function planRoomFinalization(
  roomId: string,
  dependencies: Pick<MemoryExtractorDependencies, "repository" | "gateway">,
): Promise<PreparedRoomAnalysis>;

export async function applyRoomFinalization(
  plan: PreparedRoomAnalysis,
  dependencies: Pick<MemoryExtractorDependencies, "repository" | "profileRepository">,
): Promise<RoomMemoryResult>;
```

- [ ] **Step 1: Write the failure/resume regression**

```ts
test("keeps prepared chunks and resumes after the second chunk fails", async () => {
  gateway.extract
    .mockResolvedValueOnce(chunkResult("one"))
    .mockRejectedValueOnce(new ModelResponseValidationError());

  await expect(prepareRoomChunks(roomId, dependencies, onPrepared)).rejects.toThrow();
  expect(await repository.preparedChunkIds(roomId)).toEqual(["chunk-1"]);

  gateway.extract.mockResolvedValueOnce(chunkResult("two")).mockResolvedValueOnce(chunkResult("three"));
  await prepareRoomChunks(roomId, dependencies, onPrepared);

  expect(gateway.chunkInputs()).toEqual(["chunk-1", "chunk-2", "chunk-2", "chunk-3"]);
  expect(await repository.preparedChunkIds(roomId)).toEqual(["chunk-1", "chunk-2", "chunk-3"]);
});
```

Add separate tests that a changed fingerprint invalidates a prepared payload, hierarchy failure preserves all prepared chunks, and finalization failure rolls back room memory/profile/complete markers only.

- [ ] **Step 2: Run the new tests RED**

Run: `pnpm exec vitest run tests/integration/resumable-memory-extractor.test.ts tests/integration/profile-service.test.ts`

Expected: FAIL because preparation/finalization functions and `analysisPrepared` payload semantics do not exist.

- [ ] **Step 3: Extend encrypted chunk payloads**

```ts
type ChunkMemoryPayload = {
  summary: string;
  emotions: string[];
  relationshipSignals: string[];
  candidateProfileFacts: AiProfileFact[];
  sourceFingerprint: string;
  analysisKey: string;
  analysisPrepared: boolean;
  analysisComplete: boolean;
  previousAnalysisKeys?: string[];
};
```

`listChunksForAnalysis` must skip only a payload where `analysisPrepared === true`, the source fingerprint matches, and the stored analysis key equals the deterministic current key. Legacy payloads without `analysisPrepared` remain retryable unless `analysisComplete === true` and their fingerprint matches.

- [ ] **Step 4: Checkpoint each chunk immediately**

For each pending chunk: call `extract`, validate evidence, call `embed([redactedText])`, then persist `analysisPrepared: true, analysisComplete: false` before moving to the next chunk. Call `onPrepared(completed, total)` only after that write succeeds.

- [ ] **Step 5: Separate hierarchy planning from final writes**

`planRoomFinalization` reads every prepared/current chunk, calls topic and room-summary extraction, validates complete/unique chunk coverage, and returns profile operations reconstructed from encrypted prepared payloads. It performs no profile, room-memory, or complete-marker writes.

`applyRoomFinalization` runs against transaction-bound repositories, replaces AI facts, upserts room memory, and marks all current chunks complete. A thrown write must roll back all three effects while leaving prior prepared checkpoints intact.

- [ ] **Step 6: Verify resumability and profile integrity**

Run: `pnpm exec vitest run tests/integration/resumable-memory-extractor.test.ts tests/integration/profile-service.test.ts && pnpm exec tsc --noEmit`

Expected: all focused tests PASS and TypeScript exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/domain/memory/extractor.ts tests/integration/resumable-memory-extractor.test.ts tests/integration/profile-service.test.ts
git commit -m "feat: checkpoint conversation chunk analysis"
```

---

### Task 4: Serialize Analysis Without a Long Transaction

**Files:**
- Modify: `src/db/client.ts`
- Modify: `src/domain/memory/room-analysis-orchestrator.ts`
- Modify: `src/app/api/rooms/[roomId]/analysis/route.ts`
- Create: `tests/integration/room-analysis-orchestrator.test.ts`
- Modify: `tests/unit/import-route.test.ts`

**Interfaces:**
- Produces:

```ts
export async function withDedicatedDatabase<T>(
  work: (database: NodePgDatabase<typeof schema>) => Promise<T>,
): Promise<T>;

export async function getRoomAnalysisProgress(roomId: string): Promise<AnalysisProgress | null>;
```

- [ ] **Step 1: Write failing lock, checkpoint, and safe-log tests**

```ts
test("commits a prepared chunk before a later provider failure", async () => {
  await expect(analyzeImportedRoom(roomId, dependencies)).rejects.toThrow();
  expect(await progress.get(roomId)).toMatchObject({
    status: "failed", completedChunks: 1, totalChunks: 3,
  });
  expect(await storedPreparedChunks(roomId)).toEqual(["chunk-1"]);
});

test("logs only scalar stage and failure metadata", async () => {
  expect(log).toHaveBeenCalledWith("room_analysis_failed", {
    roomId, stage: "chunks", completedChunks: 1, totalChunks: 3,
    failure: "model_validation", providerStatus: 0,
  });
  expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE_CONVERSATION");
});
```

Add a concurrency test where two room analyses overlap and the second does not enter preparation until the first releases its dedicated lock.

- [ ] **Step 2: Run orchestrator tests RED**

Run: `pnpm exec vitest run tests/integration/room-analysis-orchestrator.test.ts tests/unit/import-route.test.ts`

Expected: FAIL because the current orchestration uses one `database.transaction` around all model calls and has no run-state/log dependency.

- [ ] **Step 3: Expose a dedicated client safely**

Create one shared `Pool`. `withDedicatedDatabase` must `pool.connect()`, wrap the `PoolClient` with Drizzle, execute work, and call `client.release()` in `finally`. The orchestration must execute parameterized `pg_advisory_lock(hashtext($1))` before work and `pg_advisory_unlock(hashtext($1))` in `finally` on that same client.

- [ ] **Step 4: Coordinate short transactions and progress**

Inside the session lock:

1. reconcile chunks in `database.transaction`;
2. initialize run state;
3. call `prepareRoomChunks` on the autocommit dedicated database;
4. mark hierarchy/finalization progress;
5. call `planRoomFinalization` outside a transaction;
6. call `applyRoomFinalization` inside one short `database.transaction` with transaction-bound memory/profile repositories;
7. mark the run ready.

On error, classify it, persist failed status, call `safeLog` with scalar metadata, and rethrow for the existing generic `503` boundary.

- [ ] **Step 5: Add authenticated GET progress**

`GET /api/rooms/[roomId]/analysis` must authenticate before lookup, return 404 for an unknown room, and return either stored progress or a derived pending/ready value. It must not return encrypted or decrypted conversation/profile data.

- [ ] **Step 6: Verify orchestration and route security**

Run: `pnpm exec vitest run tests/integration/room-analysis-orchestrator.test.ts tests/unit/import-route.test.ts tests/integration/private-workflow-security.test.ts && pnpm exec tsc --noEmit`

Expected: focused tests PASS, auth-first behavior remains intact, and TypeScript exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/db/client.ts src/domain/memory/room-analysis-orchestrator.ts src/app/api/rooms/[roomId]/analysis/route.ts tests/integration/room-analysis-orchestrator.test.ts tests/unit/import-route.test.ts
git commit -m "feat: resume serialized room analysis"
```

---

### Task 5: Replace Fixed Progress with Server Polling

**Files:**
- Modify: `src/components/room-analysis-actions.tsx`
- Modify: `src/components/rooms-workspace.tsx`
- Modify: `src/components/import-progress.tsx`
- Create: `tests/unit/room-analysis-actions.test.tsx`
- Modify: `tests/unit/rooms-workspace.test.tsx`

**Interfaces:**
- Consumes: `GET /api/rooms/:roomId/analysis` returning `AnalysisProgress`.
- Produces: accessible chunk progress, finalization state, failure/retry state, and page-refresh recovery.

- [ ] **Step 1: Write failing UI polling tests**

```tsx
test("polls real chunk progress while POST analysis is pending", async () => {
  render(<RoomAnalysisActions room={needsAnalysisRoom} pollIntervalMs={1} />);
  await user.click(screen.getByRole("button", { name: "분석 다시 시도" }));
  expect(await screen.findByText("청크 17/50 분석 완료")).toBeVisible();
  expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "34");
});

test("shows finalization separately from chunk percentage", async () => {
  expect(await screen.findByText("대화방 맥락을 종합하는 중이에요")).toBeVisible();
});
```

Add tests for a persisted failed run after reload, a ready run triggering refresh, and the import flow navigating to the room detail page without retaining fixed 45/65 analysis values.

- [ ] **Step 2: Run UI tests RED**

Run: `pnpm exec vitest run tests/unit/room-analysis-actions.test.tsx tests/unit/rooms-workspace.test.tsx`

Expected: FAIL because the component does not poll and `RoomsWorkspace` uses fixed progress values.

- [ ] **Step 3: Implement polling around the in-flight POST**

Start the POST once, poll GET every 1,000 ms while it is pending, and stop polling in `finally` or when unmounted. Render `Math.floor(completedChunks / totalChunks * 100)` only when `totalChunks > 0`. Use stage copy:

- `chunks`: `청크 {completed}/{total} 분석 완료`
- `hierarchy`: `대화방 맥락을 종합하는 중이에요`
- `profiles`: `친구별 특징을 정리하는 중이에요`
- `complete`: `분석 완료`

Do not show provider codes directly; failed state uses the existing generic Korean retry copy.

- [ ] **Step 4: Route imports into the shared progress screen**

After unparsed-line review, `RoomsWorkspace` starts analysis and navigates to `/rooms/{roomId}`. Remove the claim that 45% is analysis progress. Retain upload-only progress copy for file transfer and line review.

- [ ] **Step 5: Verify UI and accessibility**

Run: `pnpm exec vitest run tests/unit/room-analysis-actions.test.tsx tests/unit/rooms-workspace.test.tsx tests/unit/app-shell.test.tsx`

Expected: tests PASS; buttons remain at least 44px through existing styles; progress has `aria-valuemin`, `aria-valuemax`, and the calculated `aria-valuenow`.

- [ ] **Step 6: Commit**

```bash
git add src/components/room-analysis-actions.tsx src/components/rooms-workspace.tsx src/components/import-progress.tsx tests/unit/room-analysis-actions.test.tsx tests/unit/rooms-workspace.test.tsx
git commit -m "feat: show resumable analysis progress"
```

---

### Task 6: Run Migration and Final Verification

**Files:**
- Modify if required by evidence: `README.md`
- Modify: `docs/acceptance/mvp-checklist.md`

**Interfaces:**
- Consumes all prior task outputs.
- Produces a migrated local database and recorded verification evidence.

- [ ] **Step 1: Apply the local migration**

Run:

```bash
DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env.local)" pnpm exec drizzle-kit migrate
```

Expected: `0002_room_analysis_runs.sql` applies successfully.

- [ ] **Step 2: Run focused and full automated verification**

Run:

```bash
pnpm exec vitest run tests/unit/model-gateway.test.ts tests/integration/analysis-progress.test.ts tests/integration/resumable-memory-extractor.test.ts tests/integration/room-analysis-orchestrator.test.ts tests/unit/room-analysis-actions.test.tsx tests/unit/rooms-workspace.test.tsx
pnpm test
pnpm test:integration
pnpm exec tsc --noEmit
pnpm build
```

Expected: every command exits 0.

- [ ] **Step 3: Run privacy and placeholder scans**

Run:

```bash
rg -n "console\.(log|error)|PRIVATE_CONVERSATION" src tests
git diff --check
```

Expected: no unsafe new logging, no placeholders in changed files, and no whitespace errors.

- [ ] **Step 4: Record acceptance evidence**

Update the acceptance checklist with resumable preparation, failure/retry, real progress, migration, focused/full test, typecheck, and build results. Do not claim that the 1,058-message live room completed until a user-triggered run actually returns 200.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/acceptance/mvp-checklist.md
git commit -m "docs: record resumable analysis verification"
```
