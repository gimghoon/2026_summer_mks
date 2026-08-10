# Recent Reference Clarification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop old, already-resolved Korean references from causing repeated `409 clarification_required` responses while preserving clarification for genuinely ambiguous recent references.

**Architecture:** Restrict deterministic reference detection in `context-expander.ts` to the latest three text-bearing turns and add one optional boolean that resolves only person-reference stems. Compute that boolean in `production-context.ts` from the current room's decrypted participant names and the user-supplied situation/intent, keeping private names local and leaving the response contract unchanged.

**Tech Stack:** TypeScript 5.9, Next.js 15, Vitest

## Global Constraints

- Only the latest three text-bearing turns participate in deterministic unresolved-reference detection.
- Existing Korean inflection support for `걔는`, `그거야`, and `그것을` remains.
- Existing false-positive protection for arbitrary `그`-prefix words such as `그래서` remains.
- Explicit participant resolution suppresses only person stems (`걔`, `그사람`, `그분`), never object/event stems such as `그거`, `그것`, or `그일`.
- Explicit participant names must come from the current room's loaded participant list and appear in the submitted `situation` or `intent`.
- The `409 clarification_required` schema and Korean question text remain unchanged when clarification is genuinely needed.
- No new logs contain participant names, pasted conversation, situation, or intent.
- Do not modify or stage `.env.local`.

---

### Task 1: Scope Deterministic Reference Detection to Recent Turns

**Files:**
- Modify: `src/domain/replies/context-expander.ts`
- Modify: `tests/unit/context-expander.test.ts`

**Interfaces:**
- Produces: optional `ContextExpansionInput.resolvedPersonReference?: boolean`
- Produces: `selectCurrentContext(input)` ignores unresolved references outside the latest three text-bearing turns
- Produces: `resolvedPersonReference: true` suppresses person-reference stems only

- [ ] **Step 1: Write failing recency and resolution tests**

Add these behaviors to `tests/unit/context-expander.test.ts`:

```ts
test("ignores an old reference when the latest three text turns are clear", async () => {
  const judge = vi.fn().mockResolvedValue({ sufficient: true, ambiguityReasons: [] });
  const turns = makeTurns(20);
  turns[10] = { ...turns[10]!, messages: [{ kind: "text", text: "그거 어떻게 할까" }] };

  const result = await selectCurrentContext({ turns, judge, fullChunkStart: 0 });

  expect(judge).toHaveBeenCalledOnce();
  expect(result).toMatchObject({ usedTurnLimit: 20, needsUserQuestion: false });
});

test("accepts a resolved recent person reference", async () => {
  const judge = vi.fn().mockResolvedValue({ sufficient: true, ambiguityReasons: [] });
  const turns = makeTurns(20, "걔는 아직 돈을 안 보냈어");

  const result = await selectCurrentContext({
    turns,
    judge,
    fullChunkStart: 0,
    resolvedPersonReference: true,
  });

  expect(judge).toHaveBeenCalledOnce();
  expect(result.needsUserQuestion).toBe(false);
});

test("does not treat an explicit person as resolving a recent object reference", async () => {
  const judge = vi.fn().mockResolvedValue({ sufficient: true, ambiguityReasons: [] });
  const turns = makeTurns(20, "그거 어떻게 할까");

  const result = await selectCurrentContext({
    turns,
    judge,
    fullChunkStart: 0,
    resolvedPersonReference: true,
  });

  expect(judge).not.toHaveBeenCalled();
  expect(result.needsUserQuestion).toBe(true);
});
```

Move the existing inflected-reference fixtures from turn index 10 to `turns.length - 2` so they continue to prove recent `걔는`, `그거야`, and `그것을` detection.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm exec vitest run tests/unit/context-expander.test.ts`

Expected: the old reference still blocks, and `resolvedPersonReference` is not accepted by the current input type.

- [ ] **Step 3: Implement recent-turn and person-stem classification**

Add the optional input and separate person stems:

```ts
export type ContextExpansionInput = {
  turns: DecryptedTurn[];
  fullChunkStart: number;
  judge: (turns: DecryptedTurn[]) => Promise<ContextSufficiency>;
  resolvedPersonReference?: boolean;
};

const personReferenceStems = new Set(["그사람", "그분", "걔"]);

function recentTextTurns(turns: DecryptedTurn[]): DecryptedTurn[] {
  return turns.filter((turn) => turn.messages.some((message) => message.kind === "text")).slice(-3);
}
```

Pass `resolvedPersonReference` into token matching. When a token matches a supported stem and suffix, return false only if that stem is in `personReferenceStems` and the optional flag is true. Run `hasUnresolvedReference` over `recentTextTurns(turns)` rather than every selected turn. Default the optional flag to false in `selectCurrentContext`.

- [ ] **Step 4: Run the unit test and verify GREEN**

Run: `pnpm exec vitest run tests/unit/context-expander.test.ts`

Expected: all context-expander tests pass.

- [ ] **Step 5: Commit the deterministic boundary**

```bash
git add src/domain/replies/context-expander.ts tests/unit/context-expander.test.ts
git commit -m "fix: scope unresolved references to recent turns"
```

---

### Task 2: Wire Explicit Room-Participant Resolution in Production

**Files:**
- Modify: `src/domain/replies/production-context.ts`
- Modify: `tests/integration/production-reply-context.test.ts`

**Interfaces:**
- Consumes: `ContextExpansionInput.resolvedPersonReference` from Task 1
- Produces: production context sets the flag only when `situation` or `intent` includes a normalized participant name from `snapshot.roomParticipants`

- [ ] **Step 1: Write a failing production regression for the repeated-409 case**

Add a test using the existing `snapshot` and `RecordingGateway`:

```ts
test("uses an explicit room participant name to resolve a recent person reference", async () => {
  const explicitCommand: GenerateRepliesCommand = {
    ...command,
    pastedConversation: "민수: 걔는 아직 돈 안 보냈어\n나: 이따 예약해야 해",
    situation: "걔는 서연을 뜻하고, 서연만 아직 돈을 안 보낸 상태다",
    intent: "서연에게 예약 전에 돈을 보내 달라고 말한다",
  };

  const context = await buildProductionReplyContext(
    explicitCommand,
    "female_friend",
    new RecordingGateway(),
    snapshot,
  );

  expect(context.currentContext.needsUserQuestion).toBe(false);
});
```

Add a companion negative case whose situation contains a non-participant name such as `영희`; it must keep `needsUserQuestion: true`.

- [ ] **Step 2: Run the production context test and verify RED**

Run: `pnpm exec vitest run tests/integration/production-reply-context.test.ts`

Expected: the known-participant case still returns `needsUserQuestion: true` because production does not pass a resolution flag.

- [ ] **Step 3: Compute and pass the explicit participant flag**

Add a private helper in `production-context.ts`:

```ts
function hasExplicitParticipantReference(
  command: Pick<GenerateRepliesCommand, "situation" | "intent">,
  participants: ProductionRoomParticipant[],
): boolean {
  const framing = normalizedName(`${command.situation}\n${command.intent}`);
  return participants.some((participant) => {
    const name = normalizedName(participant.name);
    return name.length >= 2 && framing.includes(name);
  });
}
```

Pass `resolvedPersonReference: hasExplicitParticipantReference(command, snapshot.roomParticipants)` to `selectCurrentContext`. Do not include the matched name in logs or returned metadata.

- [ ] **Step 4: Run focused unit and integration tests and verify GREEN**

Run:

```bash
pnpm exec vitest run \
  tests/unit/context-expander.test.ts \
  tests/integration/production-reply-context.test.ts
```

Expected: both files pass, including the non-participant negative case.

- [ ] **Step 5: Commit the production wiring**

```bash
git add src/domain/replies/production-context.ts tests/integration/production-reply-context.test.ts
git commit -m "fix: resolve named participants before clarification"
```

---

### Task 3: Verify and Hand Off the Clarification Fix

**Files:**
- Modify only if verification exposes an in-scope defect in the four files from Tasks 1–2

**Interfaces:**
- Consumes: completed recency and participant-resolution behavior
- Produces: verified branch ready for local merge without touching the running server or `.env.local`

- [ ] **Step 1: Run the focused regression matrix**

Run:

```bash
pnpm exec vitest run \
  tests/unit/context-expander.test.ts \
  tests/integration/production-reply-context.test.ts \
  tests/integration/reply-service.test.ts \
  tests/integration/replies-route.test.ts
```

Expected: every test passes.

- [ ] **Step 2: Run full verification sequentially**

Run:

```bash
pnpm test
pnpm test:integration
pnpm exec tsc --noEmit
pnpm build
```

Expected: all commands exit 0. Run the build in the isolated worktree, not in the user's active `main` checkout, so the live Next development cache is not modified.

- [ ] **Step 3: Inspect diff and private-file hygiene**

Run:

```bash
git diff --check
git status --short
git diff main...HEAD -- src/domain/replies/context-expander.ts src/domain/replies/production-context.ts tests/unit/context-expander.test.ts tests/integration/production-reply-context.test.ts
```

Expected: only the planned behavior and tests differ; `.env.local` is absent from the worktree and diff.

- [ ] **Step 4: Request independent code review**

Review against `docs/superpowers/specs/2026-08-10-recent-reference-clarification-design.md`. Fix every Critical or Important finding with a new failing regression before completion.

## Self-Review

- Spec coverage: Task 1 covers recency, inflections, object/person separation, and existing Korean question behavior. Task 2 covers trusted current-room names and the exact repeated-409 production boundary. Task 3 covers regression, type, build, privacy, and review gates.
- Placeholder scan: no deferred implementation, unspecified error handling, or incomplete test step remains.
- Type consistency: Task 1 produces `resolvedPersonReference?: boolean`; Task 2 consumes the same property and passes a strict boolean.
