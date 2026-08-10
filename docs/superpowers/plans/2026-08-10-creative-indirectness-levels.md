# Creative Indirectness Levels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend reply indirectness from levels 1–5 to 1–7, with level 6 providing strong implication and level 7 providing three distinct, context-grounded creative circumlocution strategies.

**Architecture:** Keep `IndirectnessLevel` and `buildStylePolicy` as the single domain source of truth, then expand the API, database constraint, browser settings, and composer around that type. Add level-specific generation guidance without changing the fixed three-candidate response contract or weakening existing fact, relationship, consent, money, safety, rejection, and promise validation.

**Tech Stack:** TypeScript 5.9, React 19, Next.js 15, Zod 4, Drizzle ORM/PostgreSQL, Vitest, Testing Library

## Global Constraints

- Existing levels 1–5 keep their current meaning and behavior.
- Level 6 uses strong implication through situation description, hedged questions, pauses, implication, emotion clues, and lingering endings.
- Level 7 uses only supplied conversational material for contextual metaphor, playful paradox, and quiet aftertaste; it must not invent facts or become unrelated poetry.
- Exactly three reply candidates remain in the existing strategy order and response schema.
- Money, consent, safety, firm rejection, and important promises remain semantically explicit at every level, including 6 and 7.
- `female_friend` continues to forbid romantic affection, jealousy, and exclusive possession.
- Default indirectness remains 3; no existing browser setting is automatically promoted.
- Do not read, modify, stage, or commit `.env.local`.

---

### Task 1: Extend the Domain Policy and Creative Generation Guidance

**Files:**
- Modify: `src/domain/replies/style-policy.ts`
- Modify: `src/domain/replies/reply-service.ts`
- Modify: `tests/unit/style-policy.test.ts`
- Modify: `tests/integration/reply-service.test.ts`
- Modify: `tests/fixtures/style-evaluation.json`

**Interfaces:**
- Produces: `IndirectnessLevel = 1 | 2 | 3 | 4 | 5 | 6 | 7`
- Produces: `buildStylePolicy(input)` with level-specific `allowedDevices`
- Consumes: unchanged `ReplyService.generateReplies(command)` and existing three-strategy output schema

- [ ] **Step 1: Write failing policy tests for levels 6 and 7**

Add assertions equivalent to:

```ts
test("levels six and seven expose progressively stronger context-grounded devices", () => {
  const six = buildStylePolicy({ relationship: "female_friend", indirectness: 6, intent: "everyday" });
  const seven = buildStylePolicy({ relationship: "female_friend", indirectness: 7, intent: "everyday" });

  expect(six.allowedDevices).toEqual(expect.arrayContaining([
    "situation_description", "hedged_question", "pause", "implication", "emotion_clue", "lingering_ending",
  ]));
  expect(seven.allowedDevices).toEqual(expect.arrayContaining([
    "contextual_metaphor", "playful_paradox", "quiet_aftertaste",
  ]));
  expect(() => buildStylePolicy({ relationship: "female_friend", indirectness: 8 as never, intent: "everyday" }))
    .toThrow("indirectness must be an integer from 1 through 7");
});

test.each([6, 7] as const)("level %s keeps protected decisions explicit", (indirectness) => {
  expect(buildStylePolicy({ relationship: "girlfriend", indirectness, intent: "consent_boundary" }).mustRemainExplicit)
    .toBe(true);
});
```

Update the fixture coverage assertion to require levels `[1, 2, 3, 4, 5, 6, 7]`, and change at least one existing synthetic case to level 6 and one to level 7 while preserving exactly 24 total cases and four cases in each required category.

- [ ] **Step 2: Run the focused policy tests and confirm RED**

Run: `pnpm exec vitest run tests/unit/style-policy.test.ts`

Expected: FAIL because `IndirectnessLevel`, the accepted range, and devices stop at 5.

- [ ] **Step 3: Implement the 1–7 policy range**

Change the type and policy map to:

```ts
export type IndirectnessLevel = 1 | 2 | 3 | 4 | 5 | 6 | 7;

const levelDevices: Record<IndirectnessLevel, string[]> = {
  1: ["direct_emotion", "direct_request", "brief_acknowledgement"],
  2: ["softened_emotion", "brief_situation", "gentle_suggestion"],
  3: ["situation_description", "hedged_question", "gentle_suggestion", "sentence_fragment"],
  4: ["situation_description", "hedged_question", "pause", "emotion_clue", "gentle_suggestion"],
  5: ["situation_description", "hedged_question", "pause", "implication", "emotion_clue"],
  6: ["situation_description", "hedged_question", "pause", "implication", "emotion_clue", "lingering_ending"],
  7: ["situation_description", "pause", "implication", "contextual_metaphor", "playful_paradox", "quiet_aftertaste"],
};
```

Accept only `[1, 2, 3, 4, 5, 6, 7]` and update the range error to `indirectness must be an integer from 1 through 7`.

- [ ] **Step 4: Write a failing generation prompt regression**

In `tests/integration/reply-service.test.ts`, use the existing fake gateway and a level-7 command. Capture its first request and assert that the system text specifies:

```ts
expect(request.system).toContain("level 7");
expect(request.system).toContain("contextual metaphor");
expect(request.system).toContain("playful implication");
expect(request.system).toContain("quiet aftertaste");
expect(request.system).toContain("supplied conversation");
expect(request.system).toContain("keep the actual decision unambiguous at every indirectness level");
```

- [ ] **Step 5: Run the generation regression and confirm RED**

Run: `pnpm exec vitest run tests/integration/reply-service.test.ts`

Expected: FAIL because the current prompt only mentions the old level-five ceiling and has no level-7 strategy guidance.

- [ ] **Step 6: Add bounded level-6 and level-7 prompt guidance**

Add a small helper inside `reply-service.ts` that returns no extra text for 1–5, strong-implication guidance for 6, and this behavior for 7:

```ts
function creativeIndirectnessGuidance(level: IndirectnessLevel): string {
  if (level === 6) {
    return "At level 6, avoid directly naming the emotion or request when the intent is not protected; imply it through the supplied situation, a hedged question, a pause, or a lingering ending.";
  }
  if (level === 7) {
    return "At level 7, stay natural and concise. Use only material from the supplied conversation. Give candidate one a contextual metaphor, candidate two a playful implication or paradox, and candidate three a quiet aftertaste. Never add unrelated poetry or invented facts.";
  }
  return "";
}
```

Pass the level into `generationSystem`, append the helper output, and replace the level-five-only safety sentence with: `For money, consent, safety, firm rejection, and important promises, keep the actual decision unambiguous at every indirectness level.`

- [ ] **Step 7: Run focused domain tests and confirm GREEN**

Run: `pnpm exec vitest run tests/unit/style-policy.test.ts tests/integration/reply-service.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit the domain policy**

```bash
git add src/domain/replies/style-policy.ts src/domain/replies/reply-service.ts tests/unit/style-policy.test.ts tests/integration/reply-service.test.ts tests/fixtures/style-evaluation.json
git commit -m "feat: add creative indirectness policies"
```

---

### Task 2: Accept and Persist Levels 6 and 7

**Files:**
- Modify: `src/domain/replies/reply-api-handler.ts`
- Modify: `src/db/schema.ts`
- Create: `src/db/migrations/0003_expand_indirectness.sql`
- Modify: `src/db/migrations/meta/_journal.json`
- Create: `src/db/migrations/meta/0003_snapshot.json`
- Modify: `tests/integration/replies-route.test.ts`
- Modify: `tests/unit/schema-contract.test.ts`

**Interfaces:**
- Consumes: `IndirectnessLevel` from Task 1
- Produces: API accepts integer levels 1–7 and rejects values outside that range
- Produces: PostgreSQL `reply_requests_indirectness_check` permits 1–7

- [ ] **Step 1: Write failing API boundary tests**

Add a parameterized test that sends levels 6 and 7 and asserts the generation command receives the same level. Add a request with level 8 and assert status 400 with no generation or persistence call.

```ts
test.each([6, 7] as const)("accepts indirectness level %s", async (indirectness) => {
  const deps = dependencies();
  const response = await createReplyPostHandler(deps)(request(validBody({ indirectness })));
  expect(response.status).toBe(200);
  expect(deps.generate).toHaveBeenCalledWith(expect.objectContaining({ indirectness }), "female_friend");
});
```

- [ ] **Step 2: Write a failing schema and migration contract test**

Assert the table check SQL contains `between 1 and 7`, the new migration drops the old named constraint and recreates it with 1–7, and `_journal.json` includes `0003_expand_indirectness`.

- [ ] **Step 3: Run API and schema tests and confirm RED**

Run: `pnpm exec vitest run tests/integration/replies-route.test.ts tests/unit/schema-contract.test.ts`

Expected: FAIL because Zod and PostgreSQL currently stop at 5 and migration 0003 does not exist.

- [ ] **Step 4: Expand the API and schema constraints**

Change the Zod field to `z.number().int().min(1).max(7).optional()` and the Drizzle check to:

```ts
check("reply_requests_indirectness_check", sql`${table.indirectness} between 1 and 7`)
```

- [ ] **Step 5: Generate and inspect the migration artifacts**

Run: `pnpm exec drizzle-kit generate --name expand_indirectness`

Confirm the generated SQL has the equivalent of:

```sql
ALTER TABLE "reply_requests" DROP CONSTRAINT "reply_requests_indirectness_check";
ALTER TABLE "reply_requests" ADD CONSTRAINT "reply_requests_indirectness_check" CHECK ("reply_requests"."indirectness" between 1 and 7);
```

Keep the generated snapshot ID, previous snapshot ID, and journal timestamp; do not hand-copy another snapshot's identifiers.

- [ ] **Step 6: Run API, schema, and Drizzle checks and confirm GREEN**

Run: `pnpm exec vitest run tests/integration/replies-route.test.ts tests/unit/schema-contract.test.ts`

Run: `pnpm exec drizzle-kit check --config=drizzle.config.ts`

Expected: both commands PASS.

- [ ] **Step 7: Commit the boundary and persistence changes**

```bash
git add src/domain/replies/reply-api-handler.ts src/db/schema.ts src/db/migrations tests/integration/replies-route.test.ts tests/unit/schema-contract.test.ts
git commit -m "feat: persist indirectness levels through seven"
```

---

### Task 3: Expose Levels 6 and 7 in Settings and Reply Composition

**Files:**
- Modify: `src/components/reply-composer.tsx`
- Modify: `src/app/settings/page.tsx`
- Modify: `tests/unit/reply-composer.test.tsx`
- Create: `tests/unit/settings-page.test.tsx`

**Interfaces:**
- Consumes: API 1–7 range from Task 2
- Produces: browser local-storage key `reply-default-indirectness` accepts and persists string values `"1"` through `"7"`
- Produces: per-request reply slider submits levels 6 and 7

- [ ] **Step 1: Write failing composer tests for level 7**

Add tests that inspect `max="7"`, select level 7 under the one-request override, and assert the request body contains `"indirectness":7`. Add a load test with local storage set to `"7"` and assert the disabled slider displays 7 before override.

- [ ] **Step 2: Write failing settings tests for saving level 7**

Render `SettingsPage`, change the slider to 7, click `기본 강도 저장`, and assert:

```ts
expect(window.localStorage.getItem("reply-default-indirectness")).toBe("7");
expect(screen.getByRole("status")).toHaveTextContent("기본 강도를 저장했어요.");
```

- [ ] **Step 3: Run component tests and confirm RED**

Run: `pnpm exec vitest run tests/unit/reply-composer.test.tsx tests/unit/settings-page.test.tsx`

Expected: FAIL because both range controls and stored-value regular expressions stop at 5.

- [ ] **Step 4: Expand the composer range and stored value parser**

Use `IndirectnessLevel` for props and state instead of repeating the numeric union. Change both the slider maximum and local-storage expression:

```tsx
if (stored && /^[1-7]$/.test(stored)) {
  const value = Number(stored) as IndirectnessLevel;
  // retain current state behavior
}

<input type="range" min="1" max="7" step="1" ... />
```

Keep the default at 3 and the existing one-request override behavior.

- [ ] **Step 5: Expand the settings range and add meaningful endpoint labels**

Use `IndirectnessLevel`, accept `/^[1-7]$/`, set `max="7"`, and change the high-end label from generic `돌려 말하기` to `창의적으로 완전 돌려 말하기` so level 7 is understandable before saving.

- [ ] **Step 6: Run focused UI tests and confirm GREEN**

Run: `pnpm exec vitest run tests/unit/reply-composer.test.tsx tests/unit/settings-page.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit the user controls**

```bash
git add src/components/reply-composer.tsx src/app/settings/page.tsx tests/unit/reply-composer.test.tsx tests/unit/settings-page.test.tsx
git commit -m "feat: expose creative reply intensity controls"
```

---

### Task 4: Verify the Complete 1–7 Feature

**Files:**
- Modify only if a verification failure exposes an in-scope defect

**Interfaces:**
- Consumes: all artifacts from Tasks 1–3
- Produces: verified, buildable 1–7 feature with no staged private environment file

- [ ] **Step 1: Run focused feature verification**

Run:

```bash
pnpm exec vitest run \
  tests/unit/style-policy.test.ts \
  tests/integration/reply-service.test.ts \
  tests/integration/replies-route.test.ts \
  tests/unit/schema-contract.test.ts \
  tests/unit/reply-composer.test.tsx \
  tests/unit/settings-page.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run the complete automated suite sequentially**

Run:

```bash
pnpm test
pnpm test:integration
pnpm exec tsc --noEmit
pnpm build
pnpm exec drizzle-kit check --config=drizzle.config.ts
```

Expected: every command exits 0. Keep TypeScript and Next build sequential because both use generated `.next` types.

- [ ] **Step 3: Inspect privacy and diff hygiene**

Run:

```bash
git diff --check
git status --short
git diff --cached --name-only
```

Expected: no whitespace errors, `.env.local` remains untracked and unstaged, and only planned source/test/migration/document files appear.

- [ ] **Step 4: Perform a manual local UI smoke without triggering paid generation**

With the user's existing dev server, open `/settings` and the current room reply page. Confirm sliders show 1–7, level 7 can be saved, and the reply composer reloads at 7. Do not click `답장 3개 만들기` during this verification.

- [ ] **Step 5: Commit any final in-scope verification correction**

If and only if Step 2 exposed an in-scope issue and a correction was made:

```bash
git add src/domain/replies/style-policy.ts src/domain/replies/reply-service.ts src/domain/replies/reply-api-handler.ts src/db/schema.ts src/db/migrations src/components/reply-composer.tsx src/app/settings/page.tsx tests/unit/style-policy.test.ts tests/integration/reply-service.test.ts tests/integration/replies-route.test.ts tests/unit/schema-contract.test.ts tests/unit/reply-composer.test.tsx tests/unit/settings-page.test.tsx tests/fixtures/style-evaluation.json
git commit -m "fix: complete creative indirectness verification"
```

Otherwise make no empty commit.

## Self-Review

- Spec coverage: Tasks 1–3 cover policy, creative behavior, protected-decision clarity, API validation, DB persistence, settings, reply override, and backward compatibility. Task 4 covers full verification and private-file hygiene.
- Placeholder scan: no TBD, TODO, unspecified error handling, or deferred implementation steps remain.
- Type consistency: all layers consume the Task 1 `IndirectnessLevel`; API and database bounds are both 1–7; browser storage and both sliders use the same range.
