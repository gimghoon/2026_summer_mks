# Bounded Conversation Chunks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent provider rejection and invalid evidence output by ensuring no conversation-analysis chunk contains more than 20 turns.

**Architecture:** Keep `chunkTurns` as the only partitioning authority and add a deterministic hard boundary before the 21st turn. The existing reconciliation layer will convert oversized stored partitions into bounded partitions while preserving stable leading IDs and prior analysis lineage.

**Tech Stack:** TypeScript 5.9, Vitest 3, Drizzle ORM, PostgreSQL, Next.js 15

## Global Constraints

- Preserve all existing 30-minute, Asia/Seoul date, and explicit-topic boundaries.
- A chunk contains at most 20 turns, inclusive.
- Reconciliation must cover every turn exactly once and preserve analysis lineage from replaced partitions.
- Existing prepared chunks with unchanged boundaries remain reusable.
- Do not run a paid full-room OpenAI analysis automatically.
- Never add or commit `.env.local`.

---

### Task 1: Add the Hard Turn Limit

**Files:**
- Modify: `src/domain/memory/chunker.ts`
- Modify: `tests/unit/chunker.test.ts`

**Interfaces:**
- Consumes: `chunkTurns(turns: ParsedTurn[], topicBoundaries: number[]): ConversationChunk[]`
- Produces: The same interface with the additional invariant `endTurnIndex - startTurnIndex + 1 <= 20`.

- [ ] **Step 1: Write the failing 136-turn regression**

Add a helper that creates continuous turns without crossing a natural boundary, then assert the exact sizes:

```ts
test("caps a continuous conversation at twenty turns per chunk", () => {
  const turns = Array.from({ length: 136 }, (_, index) => {
    const at = new Date(BASE_TIME + index * 60_000);
    return {
      speaker: `speaker-${index % 2}`,
      startedAt: at,
      endedAt: at,
      messages: [],
    } satisfies ParsedTurn;
  });

  const result = chunkTurns(turns, []);

  expect(result.map((chunk) => chunk.endTurnIndex - chunk.startTurnIndex + 1))
    .toEqual([20, 20, 20, 20, 20, 20, 16]);
});
```

- [ ] **Step 2: Run the unit regression RED**

Run: `pnpm exec vitest run tests/unit/chunker.test.ts -t "caps a continuous conversation" --reporter verbose`

Expected: FAIL because the current result is one 136-turn chunk.

- [ ] **Step 3: Implement the minimal deterministic boundary**

In `src/domain/memory/chunker.ts`, add the private constant and include the size check in `startsNewChunk`:

```ts
const MAX_TURNS_PER_CHUNK = 20;

const reachedTurnLimit = index - chunkStart >= MAX_TURNS_PER_CHUNK;
const startsNewChunk =
  reachedTurnLimit
  || gap >= THIRTY_MINUTES_MS
  || seoulCalendarDate(previous.endedAt) !== seoulCalendarDate(current.startedAt)
  || boundaries.has(index);
```

- [ ] **Step 4: Run all chunker tests GREEN**

Run: `pnpm exec vitest run tests/unit/chunker.test.ts --reporter verbose`

Expected: all existing natural-boundary tests and the new 136-turn regression PASS.

- [ ] **Step 5: Commit the bounded partitioner**

```bash
git add src/domain/memory/chunker.ts tests/unit/chunker.test.ts
git commit -m "fix: bound conversation analysis chunks"
```

---

### Task 2: Verify Oversized Partition Reconciliation

**Files:**
- Modify: `tests/integration/chunk-reconciliation.test.ts`

**Interfaces:**
- Consumes: `reconcileRoomChunks(roomId, turns, repository)` and `chunksCoverTurnsExactlyOnce(turns, chunks)`.
- Produces: Regression evidence that an old oversized partition is replaced safely under the new `chunkTurns` invariant.

- [ ] **Step 1: Write the reconciliation regression**

Seed one stable two-turn partition and one legacy 45-turn partition carrying `analysis-old-large`. Reconcile the same 47 ordered turns and assert:

```ts
expect(repository.chunks).toHaveLength(4);
expect(repository.chunks.some((chunk) => chunk.id === stableChunkId)).toBe(true);
expect(chunksCoverTurnsExactlyOnce(turns, repository.chunks)).toBe(true);

const indexes = new Map(turns.map((item, index) => [item.id, index]));
expect(repository.chunks.every((chunk) => (
  indexes.get(chunk.endTurnId)! - indexes.get(chunk.startTurnId)! + 1 <= 20
))).toBe(true);

expect(repository.chunks.some((chunk) => {
  const payload = decryptJson<{ analysisKey?: string; previousAnalysisKeys?: string[] }>(chunk.encryptedSummary);
  return payload.analysisKey === "analysis-old-large"
    || payload.previousAnalysisKeys?.includes("analysis-old-large");
})).toBe(true);
```

- [ ] **Step 2: Run reconciliation test and confirm the intended contract**

Run: `pnpm exec vitest run tests/integration/chunk-reconciliation.test.ts --reporter verbose`

Expected: PASS with the Task 1 implementation; temporarily reverting the hard-limit condition makes the new regression fail with two partitions or an oversized partition.

- [ ] **Step 3: Run focused analysis regressions**

Run: `pnpm exec vitest run tests/unit/chunker.test.ts tests/integration/chunk-reconciliation.test.ts tests/integration/profile-service.test.ts tests/integration/room-analysis-orchestrator.test.ts`

Expected: all focused tests PASS, including checkpoint, fingerprint lineage, and progress behavior.

- [ ] **Step 4: Commit the reconciliation coverage**

```bash
git add tests/integration/chunk-reconciliation.test.ts
git commit -m "test: cover oversized chunk reconciliation"
```

---

### Task 3: Final Verification and Local Handoff

**Files:**
- No production file changes expected.

**Interfaces:**
- Consumes: the bounded partitioner and existing resumable room-analysis flow.
- Produces: verified local code ready for the user to restart and retry manually.

- [ ] **Step 1: Run full automated verification**

Run sequentially:

```bash
pnpm test
pnpm test:integration
pnpm exec tsc --noEmit
pnpm build
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 2: Verify secret and worktree hygiene**

Run: `git status --short`

Expected: `.env.local` remains untracked and is not staged; no generated build or test artifact is staged.

- [ ] **Step 3: Hand off the manual paid retry**

Tell the user to stop the current dev server, run `pnpm dev`, open the existing room, and click `분석 다시 시도`. Explain that reconciliation may increase the total chunk count and the saved first ten chunks remain reusable when their boundaries and fingerprints are unchanged. Do not initiate the paid retry from automation.
