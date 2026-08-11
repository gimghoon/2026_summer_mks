# Required Personal Context Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in reply mode that makes every generated candidate naturally reflect an eligible stored participant profile fact, proves that reflection with a batched semantic check, and gives the user a recoverable profile link when no fact can be used.

**Architecture:** Keep the feature inside the existing reply pipeline: the HTTP boundary defaults the new request mode, the production context retains profile identity/provenance, a focused selector establishes the allowed evidence tier, and `ReplyService` enforces both basis-ID membership and semantic reflection before returning three candidates. Persist the selected mode in `reply_requests`; keep basis text and warnings encrypted as they are today; make the UI preference browser-local and preserve the normal-mode call path without an extra model request.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, Zod, Drizzle ORM/PostgreSQL, Vitest/Testing Library, Playwright, OpenAI structured Responses through the existing `ModelGateway`.

## Global Constraints

- The first browser use defaults to `personalContextMode: "normal"`; the composer always sends the effective value and remembers later checkbox changes in `localStorage`.
- The public mode values are exactly `"normal" | "required"`; a missing API field defaults to `"normal"`, while any other value returns HTTP 400.
- Change proposals are never eligible. Trusted facts are ordered `user_edited`, `user_confirmed`, then other locked non-proposal facts; `ai_inference` is allowed only when the trusted set is empty.
- In required mode, every one of the three candidates must select at least one allowed fact ID and naturally reflect that fact in its wording.
- Required-mode semantic validation is one batched structured model call per generation attempt; the existing maximum of two generation attempts remains unchanged.
- Normal mode performs no semantic-usage validation call and gains no new failure path.
- No eligible fact returns HTTP 409 with `{"kind":"personal_context_unavailable","message":"사용할 개인 컨텍스트가 없어요. 프로필을 먼저 확인하거나 직접 추가해 주세요."}` before generation, embedding, or persistence.
- AI-only fallback adds `unverified_profile_context` to every candidate that selected an AI-inferred fact.
- Existing contradiction, relationship, safety, specific-fact, protected-intent, exactly-three-candidate, room-participant isolation, and encryption rules remain active.
- Retry feedback and logs may contain only opaque rule IDs; never expose profile values, selected IDs, rejected candidate text, semantic explanations, or raw model output.
- Do not read, print, edit, stage, or commit `.env.local`.

---

## File and Interface Map

- Create `src/domain/replies/required-personal-context.ts`: eligibility ordering, allowed-fact selection, candidate basis-ID membership checks, and the typed unavailable constant.
- Create `src/domain/replies/personal-context-usage-validator.ts`: one batched structured semantic usage check for the three generated candidates.
- Modify `src/domain/replies/reply-service.ts`: request/result/profile provenance types, provider-free required-mode profile preflight, opaque retry IDs, semantic validation, AI fallback warning.
- Modify `src/domain/replies/reply-evidence.ts`: use stable profile-fact IDs instead of array-index IDs while preserving public summaries.
- Modify `src/domain/replies/reply-api-handler.ts`: request default/validation, typed 409 branch, and persistence contract.
- Modify `src/app/api/replies/route.ts`: retain profile IDs/sources/locks, wire the semantic validator, and persist request mode.
- Modify `src/db/schema.ts` and create generated migration `src/db/migrations/0005_required_personal_context_mode.sql` plus generated metadata.
- Modify `src/components/reply-composer.tsx` and `src/components/reply-results.tsx`: remembered checkbox, unavailable recovery panel, profile link, and AI-inference warning copy.
- Modify `src/domain/testing/e2e-fixture-store.ts`: deterministic verified/inferred/unavailable fixture behavior and encrypted mode persistence.
- Extend focused unit/integration/E2E tests listed in the tasks below; do not weaken existing assertions.

---

### Task 1: Define Eligible Profile Evidence and Stable Basis IDs

**Files:**
- Create: `src/domain/replies/required-personal-context.ts`
- Modify: `src/domain/replies/reply-service.ts`
- Modify: `src/domain/replies/reply-evidence.ts`
- Test: `tests/unit/required-personal-context.test.ts`
- Test: `tests/unit/reply-evidence.test.ts`

**Interfaces:**
- Consumes: `ProfileFactSource` from `src/db/schema.ts`.
- Produces:

```ts
export type PersonalContextMode = "normal" | "required";

export type ParticipantProfileContext = {
  id: string;
  kind: string;
  value: string;
  conditions?: string[];
  exceptions?: string[];
  source: ProfileFactSource;
  locked: boolean;
};

export type RequiredPersonalContextSelection = {
  facts: ParticipantProfileContext[];
  inferenceOnly: boolean;
};

export const PERSONAL_CONTEXT_UNAVAILABLE_MESSAGE =
  "사용할 개인 컨텍스트가 없어요. 프로필을 먼저 확인하거나 직접 추가해 주세요.";

export function selectRequiredPersonalContext(
  profiles: ParticipantProfileContext[],
): RequiredPersonalContextSelection;

export function invalidRequiredBasisIds(
  ids: string[],
  allowedFactIds: ReadonlySet<string>,
): boolean;
```

- Changes `buildPersonalContextEvidence(profiles)` to return evidence IDs equal to the stored fact IDs, not `profile-${index}`.
- Changes `ReplyContextProvider` to expose a provider-free required-mode preflight while allowing the full context load to reuse the same snapshot:

```ts
export interface ReplyContextProvider {
  loadParticipantProfiles(
    command: GenerateRepliesCommand,
  ): Promise<ParticipantProfileContext[]>;
  load(
    command: GenerateRepliesCommand,
    preloadedProfiles?: ParticipantProfileContext[],
  ): Promise<ReplyGenerationContext>;
}
```

- [ ] **Step 1: Write failing eligibility and stable-ID tests**

Add tests that construct facts with explicit IDs and assert exact tier behavior:

```ts
test("orders trusted facts and excludes proposals and inference", () => {
  const selection = selectRequiredPersonalContext([
    fact({ id: "inferred", source: "ai_inference", locked: false }),
    fact({ id: "proposal", source: "ai_change_proposal", locked: false }),
    fact({ id: "locked", source: "ai_inference", locked: true }),
    fact({ id: "confirmed", source: "user_confirmed", locked: true }),
    fact({ id: "edited", source: "user_edited", locked: true }),
  ]);

  expect(selection.facts.map(({ id }) => id)).toEqual(["edited", "confirmed", "locked"]);
  expect(selection.inferenceOnly).toBe(false);
});

test("uses AI inference only when no trusted fact exists", () => {
  const selection = selectRequiredPersonalContext([
    fact({ id: "proposal", source: "ai_change_proposal", locked: false }),
    fact({ id: "inferred", source: "ai_inference", locked: false }),
  ]);
  expect(selection).toMatchObject({ inferenceOnly: true });
  expect(selection.facts.map(({ id }) => id)).toEqual(["inferred"]);
});

test("rejects empty and unknown required basis IDs", () => {
  const allowed = new Set(["fact-a", "fact-b"]);
  expect(invalidRequiredBasisIds([], allowed)).toBe(true);
  expect(invalidRequiredBasisIds(["unknown"], allowed)).toBe(true);
  expect(invalidRequiredBasisIds(["fact-a"], allowed)).toBe(false);
});

test("uses the stored fact ID in personal context evidence", () => {
  expect(buildPersonalContextEvidence([
    fact({ id: "fact-a", kind: "response_pattern", value: "답을 짧게 함" }),
  ])).toEqual([{ id: "fact-a", summary: "response_pattern: 답을 짧게 함" }]);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
pnpm exec vitest run tests/unit/required-personal-context.test.ts tests/unit/reply-evidence.test.ts
```

Expected: FAIL because `required-personal-context.ts` and the provenance fields do not exist, and evidence IDs are currently positional.

- [ ] **Step 3: Add profile provenance and implement deterministic selection**

In `reply-service.ts`, import `ProfileFactSource`, export `PersonalContextMode`, add `personalContextMode` to `GenerateRepliesCommand`, replace the existing profile type with the exact interface above, and add the two-method `ReplyContextProvider` interface. Update test providers so `loadParticipantProfiles` returns the same profile array later exposed by `load`; keep it free of model/embed calls.

In `required-personal-context.ts`, implement:

```ts
const trustedRank: Partial<Record<ProfileFactSource, number>> = {
  user_edited: 0,
  user_confirmed: 1,
};

export function selectRequiredPersonalContext(
  profiles: ParticipantProfileContext[],
): RequiredPersonalContextSelection {
  const nonProposals = profiles.filter((fact) => fact.source !== "ai_change_proposal");
  const trusted = nonProposals
    .filter((fact) => fact.source === "user_edited"
      || fact.source === "user_confirmed"
      || fact.locked)
    .sort((left, right) => {
      const leftRank = trustedRank[left.source] ?? 2;
      const rightRank = trustedRank[right.source] ?? 2;
      return leftRank - rightRank || left.id.localeCompare(right.id);
    });
  if (trusted.length > 0) return { facts: trusted, inferenceOnly: false };
  return {
    facts: nonProposals
      .filter((fact) => fact.source === "ai_inference")
      .sort((left, right) => left.id.localeCompare(right.id)),
    inferenceOnly: true,
  };
}

export function invalidRequiredBasisIds(
  ids: string[],
  allowedFactIds: ReadonlySet<string>,
): boolean {
  return ids.length === 0 || ids.some((id) => !allowedFactIds.has(id));
}
```

Treat a locked `ai_inference` as the third trusted category, matching the approved “other locked non-proposal” rule. Proposal rows remain excluded even if locked.

- [ ] **Step 4: Switch evidence resolution to stable stored IDs**

Extend `ProfileEvidenceInput` with `id: string` and return `{ id: profile.id, summary }`. Keep whitespace normalization, truncation, deduplication, and `NO_PERSONAL_CONTEXT_BASIS` behavior unchanged.

- [ ] **Step 5: Run focused tests and all TypeScript tests affected by the required provenance fields**

Run:

```bash
pnpm exec vitest run tests/unit/required-personal-context.test.ts tests/unit/reply-evidence.test.ts tests/integration/reply-service.test.ts tests/integration/production-reply-context.test.ts tests/integration/reply-production-policy.test.ts
pnpm exec tsc --noEmit
```

Expected: PASS after updating existing test fixtures with stable `id`, `source`, and `locked`, and with `personalContextMode: "normal"` where commands are constructed directly.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/domain/replies/required-personal-context.ts src/domain/replies/reply-service.ts src/domain/replies/reply-evidence.ts tests/unit/required-personal-context.test.ts tests/unit/reply-evidence.test.ts tests/integration/reply-service.test.ts tests/integration/production-reply-context.test.ts tests/integration/reply-production-policy.test.ts
git commit -m "feat: select required personal context"
```

---

### Task 2: Enforce Required Evidence and Batched Semantic Reflection

**Files:**
- Create: `src/domain/replies/personal-context-usage-validator.ts`
- Modify: `src/domain/replies/reply-service.ts`
- Modify: `src/app/api/replies/route.ts`
- Test: `tests/unit/personal-context-usage-validator.test.ts`
- Test: `tests/integration/reply-service.test.ts`
- Test: `tests/integration/reply-production-policy.test.ts`

**Interfaces:**
- Consumes: `selectRequiredPersonalContext`, stable profile IDs, and existing `ModelGateway.extract`.
- Produces:

```ts
export type PersonalContextUsageCandidate = {
  strategy: ReplyStrategy;
  text: string;
  selectedFacts: Array<{
    id: string;
    kind: string;
    value: string;
    conditions: string[];
    exceptions: string[];
  }>;
};

export type PersonalContextUsageValidator = (
  candidates: [
    PersonalContextUsageCandidate,
    PersonalContextUsageCandidate,
    PersonalContextUsageCandidate,
  ],
) => Promise<Record<ReplyStrategy, boolean>>;

export function createPersonalContextUsageValidator(
  gateway: Pick<ModelGateway, "extract">,
): PersonalContextUsageValidator;
```

- `ReplyServiceDependencies` gains required `personalContextUsageValidator`; normal mode must never invoke it.
- `ReplyValidationRuleId` gains `REQUIRED_PERSONAL_CONTEXT_MISSING` and `PERSONAL_CONTEXT_NOT_REFLECTED`.
- `ReplyWarning` gains `unverified_profile_context`.
- `ReplyGenerationResult` gains `{ kind: "personal_context_unavailable"; message: string }`.
- The two new required-mode rule IDs are fatal retry rules, not advisory warnings. Replace the broad content-rule alias with:

```ts
export type ReplyAdvisoryValidationRuleId = Exclude<
  ReplyValidationRuleId,
  | "OUTPUT_STRUCTURE"
  | "REQUIRED_PERSONAL_CONTEXT_MISSING"
  | "PERSONAL_CONTEXT_NOT_REFLECTED"
>;
```

`warningByRule`, `warningForRule`, and `flattenValidationRuleIds` continue to accept only `ReplyAdvisoryValidationRuleId`. This prevents required-mode failures from being converted into level 6–7 warning badges.

- [ ] **Step 1: Write RED service tests for no-fact, structural selection, semantic retry, and normal-mode call count**

Add focused cases using spies for both gateway and usage validator:

```ts
test("returns unavailable before generation when required mode has no eligible fact", async () => {
  const gateway = gatewayWithReplies(validTuple());
  const semantic = vi.fn();
  const result = await generateReplies(
    { ...command, personalContextMode: "required" },
    dependencies({ gateway, semantic, participantProfiles: [] }),
  );

  expect(result).toEqual({
    kind: "personal_context_unavailable",
    message: PERSONAL_CONTEXT_UNAVAILABLE_MESSAGE,
  });
  expect(gateway.extract).not.toHaveBeenCalled();
  expect(gateway.embed).not.toHaveBeenCalled();
  expect(semantic).not.toHaveBeenCalled();
  expect(contextProvider.load).not.toHaveBeenCalled();
});

test.each([
  [[], "empty"],
  [["unknown"], "unknown"],
  [["inferred-id"], "inference while trusted exists"],
])("retries required mode with opaque basis rule for %s", async (basisIds) => {
  const gateway = gatewayWithReplies(
    generatedTuple(basisIds),
    generatedTuple([["trusted-id"], ["trusted-id"], ["trusted-id"]]),
  );
  const result = await generateReplies(
    { ...command, personalContextMode: "required" },
    dependencies({ gateway, semantic: alwaysReflected, participantProfiles: trustedAndInferredFacts }),
  );
  expect(JSON.parse(gateway.requests[1]!.input).validationRuleIds)
    .toEqual(["REQUIRED_PERSONAL_CONTEXT_MISSING"]);
  expect(result.kind).toBe("replies");
});

test("checks all three candidates in one semantic call and retries opaquely", async () => {
  const semantic = vi.fn()
    .mockResolvedValueOnce({ relationship_soft: true, emotion_signal: false, clearer_request: true })
    .mockResolvedValueOnce({ relationship_soft: true, emotion_signal: true, clearer_request: true });
  const gateway = gatewayWithReplies(validRequiredTuple(), validRequiredTuple());
  await generateReplies(
    { ...command, personalContextMode: "required" },
    dependencies({ gateway, semantic, participantProfiles: trustedFacts }),
  );
  expect(semantic).toHaveBeenCalledTimes(2);
  expect(semantic.mock.calls[0]![0]).toHaveLength(3);
  expect(JSON.parse(gateway.requests[1]!.input).validationRuleIds)
    .toEqual(["PERSONAL_CONTEXT_NOT_REFLECTED"]);
  expect(JSON.stringify(JSON.parse(gateway.requests[1]!.input).validationRuleIds))
    .not.toContain(trustedFacts[0]!.value);
});

test("normal mode neither calls semantic validation nor adds inference warnings", async () => {
  const semantic = vi.fn(async () => { throw new Error("must not run"); });
  const result = await generateReplies(
    { ...command, personalContextMode: "normal" },
    dependencies({ semantic, participantProfiles: inferredFacts }),
  );
  expect(result.kind).toBe("replies");
  expect(semantic).not.toHaveBeenCalled();
});
```

Also cover independent fact IDs per strategy, reuse of the same best ID by all three candidates, AI-only fallback warning on all affected candidates, generic `ReplyGenerationValidationError` after the second semantic failure, and the absence of private profile values/rejected text in the thrown error and retry input.

- [ ] **Step 2: Run the service tests and verify RED**

Run:

```bash
pnpm exec vitest run tests/integration/reply-service.test.ts
```

Expected: FAIL because the new result, rule IDs, selection enforcement, and semantic dependency do not yet exist.

- [ ] **Step 3: Implement the structured batched semantic validator with a minimal response schema**

Use a strict schema that returns no explanations:

```ts
const semanticUsageSchema = z.object({
  candidates: z.array(z.object({
    strategy: z.enum(["relationship_soft", "emotion_signal", "clearer_request"]),
    reflected: z.boolean(),
  })).length(3),
});
```

Call `gateway.extract` once with `purpose: "reply"`, schema name `personal_context_usage_check`, and a system instruction that defines reflection as a natural semantic influence, rejects verbatim profile disclosure/profiling language, and returns booleans only. Validate exact strategy order and convert the array to `Record<ReplyStrategy, boolean>`; malformed order throws `ModelResponseValidationError` so the existing generic provider failure path handles it.

- [ ] **Step 4: Integrate required-mode structural and semantic validation into the two-attempt loop**

Before loading the embedding/retrieval-backed full context, preflight required mode:

```ts
const preloadedProfiles = command.personalContextMode === "required"
  ? await this.dependencies.contextProvider.loadParticipantProfiles(command)
  : undefined;
const requiredSelection = preloadedProfiles
  ? selectRequiredPersonalContext(preloadedProfiles)
  : null;
if (requiredSelection && requiredSelection.facts.length === 0) {
  return { kind: "personal_context_unavailable", message: PERSONAL_CONTEXT_UNAVAILABLE_MESSAGE };
}
const context = await this.dependencies.contextProvider.load(command, preloadedProfiles);
const evidenceProfiles = requiredSelection?.facts ?? context.participantProfiles;
const personalContextEvidence = buildPersonalContextEvidence(evidenceProfiles);
```

This replaces the current unconditional `contextProvider.load(command)` at the top of `generateReplies`. Normal mode calls only `load`; required mode calls `loadParticipantProfiles` first and passes that exact array into `load`. Therefore the no-fact branch happens before current-context judging, embeddings, retrieval, generation, or persistence.

In the generation input, include only the allowed evidence list when required and add a concise rule telling every candidate to choose at least one supplied ID and naturally apply it. After regular validation:

1. Check each generated `contextBasisIds` against the allowed ID set. If any fails, set only `REQUIRED_PERSONAL_CONTEXT_MISSING` for retry.
2. Build each semantic item by resolving only its selected allowed IDs to server-side facts.
3. Call the usage validator once for the tuple. If any strategy is false, set only `PERSONAL_CONTEXT_NOT_REFLECTED` for retry.
4. Do not pass profile values, selected IDs, or candidate text in `validationRuleIds` or error messages.
5. Apply required structural/semantic gates even at indirectness 6–7. Keep the existing advisory behavior for the pre-existing safety/content checks at those levels; required-mode failures are not advisory.
6. When returning candidates, add `unverified_profile_context` only to candidates whose selected IDs point to AI-inferred facts in an inference-only selection.

Keep `validateCandidates` returning advisory rule IDs only. Perform required basis and semantic checks in explicit branches before the existing `indirectness >= 6` early return. On the second required-mode failure, throw `ReplyGenerationValidationError` with only the corresponding opaque fatal rule ID.

- [ ] **Step 5: Wire the production validator**

In `src/app/api/replies/route.ts`, create the OpenAI gateway once per request and pass:

```ts
personalContextUsageValidator: createPersonalContextUsageValidator(gateway),
```

alongside `gateway`, `contextProvider`, and `factValidator`. The same gateway object is reused; normal mode still causes no semantic extract call.

The production `contextProvider` must implement `loadParticipantProfiles` with only the scoped/decrypted `listProfileFacts(command.participantId)` query. Its `load(command, preloadedProfiles)` passes preloaded facts through `replyContext` and `productionContextSnapshot`, preventing a second profile query and ensuring the preflight facts are the facts used for generation.

- [ ] **Step 6: Run focused validation and policy regressions**

Run:

```bash
pnpm exec vitest run tests/unit/personal-context-usage-validator.test.ts tests/integration/reply-service.test.ts tests/integration/reply-production-policy.test.ts
pnpm exec tsc --noEmit
```

Expected: PASS, including the existing contradiction, relationship, safety, explicit-intent, level 6–7 advisory, exact ordering, and one-retry tests.

- [ ] **Step 7: Commit Task 2**

```bash
git add src/domain/replies/personal-context-usage-validator.ts src/domain/replies/reply-service.ts src/app/api/replies/route.ts tests/unit/personal-context-usage-validator.test.ts tests/integration/reply-service.test.ts tests/integration/reply-production-policy.test.ts
git commit -m "feat: validate personal context reflection"
```

---

### Task 3: Add API, Production Profile, Persistence, and Migration Contracts

**Files:**
- Modify: `src/domain/replies/reply-api-handler.ts`
- Modify: `src/app/api/replies/route.ts`
- Modify: `src/domain/replies/production-context.ts`
- Modify: `src/db/schema.ts`
- Create: `src/db/migrations/0005_required_personal_context_mode.sql` using Drizzle generation
- Create/Modify: `src/db/migrations/meta/0005_snapshot.json` using Drizzle generation
- Modify: `src/db/migrations/meta/_journal.json` using Drizzle generation
- Test: `tests/integration/replies-route.test.ts`
- Test: `tests/integration/production-reply-context.test.ts`
- Test: `tests/unit/schema-contract.test.ts`
- Test: `tests/integration/private-workflow-security.test.ts`

**Interfaces:**
- Consumes: `PersonalContextMode`, the typed unavailable result, and full `ParticipantProfileContext` provenance.
- Produces: API body `personalContextMode?: "normal" | "required"`; command always contains an effective mode; persistence input carries the command; production profile preflight remains room-participant scoped and provider-free; DB column `reply_requests.personal_context_mode` is non-null text with default `normal` and a two-value check constraint.

- [ ] **Step 1: Write failing HTTP boundary and privacy tests**

Extend `validBody()` and dependency-spy assertions:

```ts
test("defaults a missing personal context mode to normal", async () => {
  const deps = dependencies();
  const response = await createReplyPostHandler(deps)(request(validBody()));
  expect(response.status).toBe(200);
  expect(deps.generate).toHaveBeenCalledWith(
    expect.objectContaining({ personalContextMode: "normal" }),
    "female_friend",
  );
});

test("accepts required mode and persists it", async () => {
  const deps = dependencies();
  await createReplyPostHandler(deps)(request(validBody({ personalContextMode: "required" })));
  expect(deps.persist).toHaveBeenCalledWith(expect.objectContaining({
    command: expect.objectContaining({ personalContextMode: "required" }),
  }));
});

test("rejects an unknown personal context mode", async () => {
  const deps = dependencies();
  const response = await createReplyPostHandler(deps)(request(validBody({ personalContextMode: "always" })));
  expect(response.status).toBe(400);
  expect(deps.generate).not.toHaveBeenCalled();
});

test("returns typed unavailable without persistence", async () => {
  const deps = dependencies({
    generate: vi.fn(async () => ({
      kind: "personal_context_unavailable" as const,
      message: PERSONAL_CONTEXT_UNAVAILABLE_MESSAGE,
    })),
  });
  const response = await createReplyPostHandler(deps)(request(validBody({ personalContextMode: "required" })));
  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toEqual({
    kind: "personal_context_unavailable",
    message: PERSONAL_CONTEXT_UNAVAILABLE_MESSAGE,
  });
  expect(deps.persist).not.toHaveBeenCalled();
});
```

Add a security assertion that neither logs nor the 409 body contain a private fact value or selected fact ID.

- [ ] **Step 2: Write failing production-profile and schema tests**

Assert `productionContextSnapshot`/`buildProductionReplyContext` preserves `{ id, source, locked }`, proposal facts do not enter required selection, and schema exposes `personalContextMode`.

Add to `schema-contract.test.ts`:

```ts
test("stores the required personal context request mode", () => {
  expect(Object.keys(getTableColumns(replyRequests))).toContain("personalContextMode");
  const migration = readFileSync(
    "src/db/migrations/0005_required_personal_context_mode.sql",
    "utf8",
  );
  expect(migration).toMatch(/ADD COLUMN "personal_context_mode" text DEFAULT 'normal' NOT NULL/iu);
  expect(migration).toMatch(/CHECK \("reply_requests"\."personal_context_mode" in \('normal', 'required'\)\)/iu);
});
```

- [ ] **Step 3: Run HTTP, production context, and schema tests and verify RED**

Run:

```bash
pnpm exec vitest run tests/integration/replies-route.test.ts tests/integration/production-reply-context.test.ts tests/unit/schema-contract.test.ts tests/integration/private-workflow-security.test.ts
```

Expected: FAIL because request parsing/defaulting, typed 409 handling, provenance mapping, DB column, and migration do not exist.

- [ ] **Step 4: Implement API defaulting and typed result handling**

Add to the strict Zod body:

```ts
personalContextMode: z.enum(["normal", "required"]).optional(),
```

Set `command.personalContextMode = body.personalContextMode ?? "normal"`. After generation, branch before persistence:

```ts
if (result.kind === "personal_context_unavailable") {
  return Response.json(result, { status: 409 });
}
```

Keep clarification handling and the generic 500 catch unchanged. The typed unavailable branch must not call `persist` or `log`.

- [ ] **Step 5: Preserve production profile identity and provenance**

Extract a focused `loadParticipantProfileContext(participantId)` function that maps every `listProfileFacts()` entry into:

```ts
{
  id: fact.id,
  kind: fact.kind,
  value: fact.value,
  conditions: fact.conditions,
  exceptions: fact.exceptions,
  source: fact.source,
  locked: fact.locked,
}
```

Do not expose this data to the client. Keep the selected participant scope enforced by the existing `listProfileFacts(command.participantId)` call plus the room-participant check before generation.

Change `productionContextSnapshot(command, preloadedProfiles?)` so it uses the passed facts instead of issuing `listProfileFacts` again. Implement the context provider as:

```ts
contextProvider: {
  loadParticipantProfiles: (currentCommand) =>
    loadParticipantProfileContext(currentCommand.participantId),
  load: (currentCommand, preloadedProfiles) =>
    replyContext(currentCommand, relationship, gateway, preloadedProfiles),
},
```

The shared HTTP handler has already verified that the participant belongs to the room before generation, so this preflight does not broaden scope. Add a production-wiring regression that required/no-fact returns before `gateway.embed`, while normal mode never calls the profile-preflight method.

- [ ] **Step 6: Add the schema column and generate migration artifacts with Drizzle**

In `replyRequests`, add:

```ts
personalContextMode: text("personal_context_mode").notNull().default("normal"),
```

and add:

```ts
check(
  "reply_requests_personal_context_mode_check",
  sql`${table.personalContextMode} in ('normal', 'required')`,
),
```

Generate rather than hand-edit migration metadata:

```bash
pnpm exec drizzle-kit generate --name required_personal_context_mode
```

Expected generated files: `0005_required_personal_context_mode.sql`, `meta/0005_snapshot.json`, and a `0005_required_personal_context_mode` journal entry. Inspect the SQL to ensure existing rows receive `normal`, the column is non-null, and the check constraint contains exactly the two allowed values.

- [ ] **Step 7: Persist the effective request mode**

Add `personalContextMode: command.personalContextMode` to the `replyRequests` insert. Candidate basis and warning arrays remain encrypted through `encryptJson`; do not add a plaintext fact-ID column.

- [ ] **Step 8: Run focused tests and Drizzle validation**

Run:

```bash
pnpm exec vitest run tests/integration/replies-route.test.ts tests/integration/production-reply-context.test.ts tests/unit/schema-contract.test.ts tests/integration/private-workflow-security.test.ts
pnpm exec drizzle-kit check --config=drizzle.config.ts
pnpm exec tsc --noEmit
```

Expected: all tests PASS, Drizzle prints `Everything's fine`, and TypeScript exits 0.

- [ ] **Step 9: Commit Task 3**

```bash
git add src/domain/replies/reply-api-handler.ts src/app/api/replies/route.ts src/domain/replies/production-context.ts src/db/schema.ts src/db/migrations/0005_required_personal_context_mode.sql src/db/migrations/meta/0005_snapshot.json src/db/migrations/meta/_journal.json tests/integration/replies-route.test.ts tests/integration/production-reply-context.test.ts tests/unit/schema-contract.test.ts tests/integration/private-workflow-security.test.ts
git commit -m "feat: persist required personal context mode"
```

---

### Task 4: Add Remembered Composer Control, Recovery UI, and Warning Copy

**Files:**
- Modify: `src/components/reply-composer.tsx`
- Modify: `src/components/reply-results.tsx`
- Modify: `src/app/globals.css`
- Test: `tests/unit/reply-composer.test.tsx`
- Test: `tests/unit/reply-results.test.tsx`

**Interfaces:**
- Consumes: public API results `replies`, `clarification_required`, and `personal_context_unavailable`.
- Produces: localStorage key `reply-required-personal-context`, stored as `"true"` or `"false"`; profile URL `/rooms/${roomId}/profiles/${participantId}`.

- [ ] **Step 1: Write failing composer persistence and request tests**

Add tests that clear localStorage in cleanup and assert:

```ts
test("defaults personal context enforcement off and remembers a changed choice", () => {
  const { unmount } = render(<ReplyComposer roomId="r1" participantId="p1" />);
  const checkbox = screen.getByRole("checkbox", { name: "개인 컨텍스트 강제 반영" });
  expect(checkbox).not.toBeChecked();
  fireEvent.click(checkbox);
  expect(localStorage.getItem("reply-required-personal-context")).toBe("true");
  unmount();
  render(<ReplyComposer roomId="r1" participantId="p1" />);
  expect(screen.getByRole("checkbox", { name: "개인 컨텍스트 강제 반영" })).toBeChecked();
});

test("always sends the effective personal context mode", async () => {
  // Fill the three required fields, generate, and inspect the parsed fetch body.
  expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string))
    .toMatchObject({ personalContextMode: "normal" });
});
```

Add a second request assertion for the checked state sending `required`.

- [ ] **Step 2: Write failing unavailable-recovery and warning-label tests**

Mock a 409 typed response and assert the UI renders the exact message plus a link with:

```ts
expect(screen.getByRole("link", { name: "프로필 확인하기" }))
  .toHaveAttribute("href", "/rooms/r1/profiles/p1");
```

Render a candidate with `warnings: ["unverified_profile_context"]` and assert the exact notice:

```text
AI가 추정한 개인 컨텍스트를 사용했어요. 실제 성향과 맞는지 확인해 주세요.
```

- [ ] **Step 3: Run component tests and verify RED**

Run:

```bash
pnpm exec vitest run tests/unit/reply-composer.test.tsx tests/unit/reply-results.test.tsx
```

Expected: FAIL because the checkbox, remembered state, typed unavailable view, link, and warning label do not exist.

- [ ] **Step 4: Implement remembered per-request mode in the composer**

Add state initialized to false and a mount effect that accepts only stored `"true"`/`"false"`. On change, update state and localStorage immediately. Render:

```tsx
<label className="context-mode-toggle">
  <input
    type="checkbox"
    checked={personalContextRequired}
    onChange={(event) => {
      setPersonalContextRequired(event.target.checked);
      window.localStorage.setItem(
        "reply-required-personal-context",
        String(event.target.checked),
      );
    }}
  />
  개인 컨텍스트 강제 반영
</label>
<p className="muted">
  켜면 모든 답장에 저장된 성향·말투·반응 패턴을 자연스럽게 반영해요.
</p>
```

Always add `personalContextMode: personalContextRequired ? "required" : "normal"` to the request body.

- [ ] **Step 5: Implement the typed unavailable recovery panel**

Extend the local `Result` union with:

```ts
{ kind: "personal_context_unavailable"; message: string }
```

Handle this result before the generic non-OK branch. Render an accessible section with the returned message and a Next `Link` to `/rooms/${roomId}/profiles/${participantId}` labeled `프로필 확인하기`. Do not lose the user’s conversation/situation/intent fields, so they can return and retry.

- [ ] **Step 6: Add AI-inference warning copy and minimal styling**

Map:

```ts
unverified_profile_context:
  "AI가 추정한 개인 컨텍스트를 사용했어요. 실제 성향과 맞는지 확인해 주세요.",
```

Reuse the existing warning list styling. Add only focused styles for the mode toggle and unavailable recovery action, preserving 44px interactive targets, visible focus, responsive layout, and current design tokens.

- [ ] **Step 7: Run component tests and build-sensitive type checking**

Run:

```bash
pnpm exec vitest run tests/unit/reply-composer.test.tsx tests/unit/reply-results.test.tsx
pnpm exec tsc --noEmit
pnpm build
```

Expected: component tests PASS, TypeScript exits 0, and Next production build succeeds.

- [ ] **Step 8: Commit Task 4**

```bash
git add src/components/reply-composer.tsx src/components/reply-results.tsx src/app/globals.css tests/unit/reply-composer.test.tsx tests/unit/reply-results.test.tsx
git commit -m "feat: add personal context reply control"
```

---

### Task 5: Align Fixture Browser Flow and Complete Acceptance Verification

**Files:**
- Modify: `src/domain/testing/e2e-fixture-store.ts`
- Modify: `src/app/api/replies/route.ts`
- Modify: `tests/unit/e2e-fixture-store.test.ts`
- Modify: `tests/e2e/private-reply-flow.spec.ts`
- Modify: `docs/acceptance/mvp-checklist.md`
- Create: `docs/superpowers/reports/2026-08-11-required-personal-context-mode.md`

**Interfaces:**
- Consumes: the same `GenerateRepliesCommand` and `ReplyGenerationResult` used by production.
- Produces: deterministic fixture cases selected from fixture participant facts; stored fixture request includes encrypted `personalContextMode`; browser flow proves remembered state and all three public outcomes.

- [ ] **Step 1: Write failing fixture contract tests**

Add fixture participants/facts for three states:

1. a user-confirmed or user-edited usable fact;
2. AI-inference-only facts;
3. no eligible facts or proposals only.

Assert:

```ts
test("fixture required mode reflects verified facts in all candidates", () => {
  const result = generateFixtureReplies(requiredInputFor(verifiedParticipantId));
  expect(result.kind).toBe("replies");
  if (result.kind !== "replies") return;
  expect(result.candidates.every((candidate) => (
    candidate.contextBasis.length > 0
      && !candidate.contextBasis.includes(NO_PERSONAL_CONTEXT_BASIS)
  ))).toBe(true);
});

test("fixture inference fallback warns every candidate", () => {
  const result = generateFixtureReplies(requiredInputFor(inferredParticipantId));
  expect(result.kind).toBe("replies");
  if (result.kind !== "replies") return;
  expect(result.candidates.every((candidate) => (
    candidate.warnings.includes("unverified_profile_context")
  ))).toBe(true);
});

test("fixture no-fact required mode returns unavailable without storage", () => {
  const before = fixtureRoomCounts(roomId).replyRequests;
  expect(generateFixtureReplies(requiredInputFor(emptyParticipantId))).toEqual({
    kind: "personal_context_unavailable",
    message: PERSONAL_CONTEXT_UNAVAILABLE_MESSAGE,
  });
  expect(fixtureRoomCounts(roomId).replyRequests).toBe(before);
});
```

Also decrypt fixture stored payloads in the test-only helper and assert the mode was persisted encrypted, not added to logs or plaintext store fields.

- [ ] **Step 2: Add failing Playwright coverage for remembered mode and recovery**

Extend `private-reply-flow.spec.ts` to:

- enable `개인 컨텍스트 강제 반영` and generate three verified-fact candidates;
- reload the reply page and assert the checkbox remains checked;
- select the AI-only fixture participant and assert all three cards show the inference warning;
- select the no-fact participant and assert the exact unavailable message and `프로필 확인하기` link;
- navigate to the profile link and confirm the selected participant profile page opens.

Use role/name locators scoped to the reply workspace and cards; do not assert internal UUID text.

- [ ] **Step 3: Run fixture tests and Playwright discovery and verify RED**

Run:

```bash
pnpm exec vitest run tests/unit/e2e-fixture-store.test.ts
pnpm exec playwright test --list
```

Expected: fixture unit tests FAIL until the adapter implements the contract; Playwright discovery succeeds and lists the updated private flow.

- [ ] **Step 4: Implement fixture selection, candidate reflection, and encrypted mode storage**

Change fixture generator input to `GenerateRepliesCommand`. Reuse `selectRequiredPersonalContext` instead of duplicating tier logic. In required mode:

- return the typed unavailable result before pushing a fixture reply request when no fact exists;
- create three deterministic but strategy-distinct texts that naturally incorporate the selected fact meaning;
- allow the same fact for all candidates or select different allowed facts deterministically by strategy index;
- set each public `contextBasis` from stable evidence resolution;
- add `unverified_profile_context` for AI-only selected facts;
- store `encryptedPersonalContextMode: encryptJson(input.personalContextMode)` in `FixtureReplyRequest` and include it in `fixtureStoredPayloads`.

Normal fixture behavior must keep its existing candidate text, clarification flow, and call count.

- [ ] **Step 5: Wire fixture route result without double persistence**

Continue letting `generateFixtureReplies` store successful fixture requests before return; keep fixture `persist()` empty. Ensure a fixture typed unavailable result reaches the shared HTTP handler and returns 409 without a stored request.

- [ ] **Step 6: Run the focused feature matrix**

Run:

```bash
pnpm exec vitest run \
  tests/unit/required-personal-context.test.ts \
  tests/unit/personal-context-usage-validator.test.ts \
  tests/unit/reply-evidence.test.ts \
  tests/unit/reply-composer.test.tsx \
  tests/unit/reply-results.test.tsx \
  tests/unit/schema-contract.test.ts \
  tests/unit/e2e-fixture-store.test.ts \
  tests/integration/reply-service.test.ts \
  tests/integration/replies-route.test.ts \
  tests/integration/production-reply-context.test.ts \
  tests/integration/reply-production-policy.test.ts \
  tests/integration/private-workflow-security.test.ts
```

Expected: all focused tests PASS.

- [ ] **Step 7: Run complete non-browser verification sequentially**

Run commands sequentially so `.next/types` is not replaced during TypeScript checking:

```bash
pnpm exec vitest run tests/unit
pnpm exec vitest run tests/integration
pnpm exec tsc --noEmit
pnpm exec drizzle-kit check --config=drizzle.config.ts
pnpm build
git diff --check
```

Expected: all unit and integration tests PASS, TypeScript exits 0, Drizzle reports a valid schema, production build succeeds, and diff check prints nothing.

- [ ] **Step 8: Run browser verification where the configured browser is available**

Run:

```bash
pnpm exec playwright test tests/e2e/private-reply-flow.spec.ts
```

Expected: the private reply browser flow PASSes. If the environment cannot bind a local port or has no browser executable, record the exact environment failure and retain successful `playwright test --list` evidence without claiming runtime browser success.

- [ ] **Step 9: Perform privacy and scope scans**

Run:

```bash
rg -n "console\.(log|debug)|selectedFacts|semantic.*explanation|raw.*model|profile.*value" src/app/api/replies src/domain/replies src/components
git status --short
```

Inspect every match. Required outcome: no client response, log metadata, retry rule array, or plaintext DB column contains a profile value, selected fact ID, rejected candidate, semantic explanation, or raw model output. `git status --short` may show `.env.local`; it must remain untracked and unstaged.

- [ ] **Step 10: Update acceptance evidence and write the implementation report**

Update `docs/acceptance/mvp-checklist.md` with the required-mode acceptance cases and exact successful command counts. Write `docs/superpowers/reports/2026-08-11-required-personal-context-mode.md` containing:

- implemented files and behavior;
- RED/GREEN evidence per task;
- final focused/unit/integration/typecheck/Drizzle/build/browser results;
- privacy scan result;
- any environment-limited verification explicitly marked as not run;
- confirmation that `.env.local` was untouched and unstaged.

- [ ] **Step 11: Commit Task 5**

```bash
git add src/domain/testing/e2e-fixture-store.ts src/app/api/replies/route.ts tests/unit/e2e-fixture-store.test.ts tests/e2e/private-reply-flow.spec.ts docs/acceptance/mvp-checklist.md docs/superpowers/reports/2026-08-11-required-personal-context-mode.md
git commit -m "test: verify required personal context flow"
```

- [ ] **Step 12: Verify final history and cleanliness**

Run:

```bash
git status --short
git log -5 --oneline
```

Expected: only the pre-existing untracked `.env.local` appears; the five feature commits are visible and no generated test artifact is staged.
