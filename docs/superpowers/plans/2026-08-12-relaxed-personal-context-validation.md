# Relaxed Personal-Context Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Return all three otherwise-valid required-personal-context replies when semantic reflection is weak or cannot be verified, with candidate-level advisory warnings instead of `PERSONAL_CONTEXT_NOT_REFLECTED` failures.

**Architecture:** Keep valid stored profile-fact IDs mandatory and keep the existing candidate validation pipeline unchanged. Convert the batched semantic usage validator's per-strategy booleans into candidate warnings, and fail open with an unverified warning if that validator throws. Reuse the existing `ReplyCandidate.warnings` API and encrypted persistence boundary, then add UI labels for the two new warning identifiers.

**Tech Stack:** TypeScript, Next.js 15, React 19, Zod, Vitest, Testing Library, Drizzle ORM.

## Global Constraints

- The change applies only when `personalContextMode` is `required`; normal mode remains unchanged.
- Every required-mode candidate still supplies at least one eligible stored profile-fact ID through `contextBasisIds`.
- Missing or unknown basis IDs retain the existing retry and final failure behavior.
- Semantic `false` results never trigger regeneration or `PERSONAL_CONTEXT_NOT_REFLECTED`.
- Semantic-validator request or response failures fail open and do not expose private inputs.
- Existing contradiction, unsupported-specific-fact, relationship, agency/safety, personal-device, duplicate, and protected-intent rules remain unchanged.
- No private profile value, candidate text, or semantic-validator payload is added to logs or client errors.
- Do not read, edit, stage, or commit `.env.local`.

---

## File map

- Modify `src/domain/replies/reply-service.ts`: add two warning identifiers and convert semantic results into candidate-aligned warnings.
- Modify `tests/integration/reply-service.test.ts`: prove weak and unavailable semantic verification is advisory while basis-ID enforcement remains blocking.
- Modify `src/components/reply-results.tsx`: map the new warning identifiers to Korean notices.
- Modify `tests/unit/reply-results.test.tsx`: verify both notices render.
- Modify `tests/integration/replies-route.test.ts`: verify warning-bearing candidates reach persistence unchanged.
- Create `docs/superpowers/reports/2026-08-12-relaxed-personal-context-validation.md`: record TDD and final verification evidence.

### Task 1: Make semantic personal-context reflection advisory

**Files:**
- Modify: `tests/integration/reply-service.test.ts`
- Modify: `src/domain/replies/reply-service.ts`

**Interfaces:**
- Consumes: `PersonalContextUsageValidator(candidates, grounding) => Promise<Record<ReplyStrategy, boolean>>`.
- Produces: `ReplyWarning` values `personal_context_weakly_reflected` and `personal_context_reflection_unverified`.
- Preserves: `invalidRequiredBasisIds(contextBasisIds, allowedFactIds)` as the blocking required-context gate.

- [ ] **Step 1: Replace the fail-closed semantic regression with a failing advisory regression**

In `tests/integration/reply-service.test.ts`, replace the existing second-failure test with:

```ts
test("returns candidate-aligned warnings without retrying weak semantic reflection", async () => {
  const gateway = new FakeGateway([requiredTuple()]);
  const semantic = vi.fn<ReplyServiceDependencies["personalContextUsageValidator"]>(
    async () => ({
      relationship_soft: false,
      emotion_signal: true,
      clearer_request: false,
    }),
  );

  const result = await generateReplies(
    { ...command, personalContextMode: "required" },
    dependencies(gateway, {
      contextProvider: {
        loadParticipantProfiles: async () => trustedFacts,
        load: async (_command, preloadedProfiles) => ({
          ...context,
          participantProfiles: preloadedProfiles ?? trustedFacts,
        }),
      },
      personalContextUsageValidator: semantic,
    }),
  );

  expect(result.kind).toBe("replies");
  if (result.kind !== "replies") return;
  expect(gateway.requests).toHaveLength(1);
  expect(semantic).toHaveBeenCalledTimes(1);
  expect(result.candidates.map((candidate) => candidate.warnings)).toEqual([
    ["personal_context_weakly_reflected"],
    [],
    ["personal_context_weakly_reflected"],
  ]);
});
```

- [ ] **Step 2: Add a failing validator-unavailable regression**

```ts
test("returns unverified warnings when semantic personal-context validation fails", async () => {
  const privateFailure = "PRIVATE_VALIDATOR_PAYLOAD";
  const gateway = new FakeGateway([requiredTuple()]);
  const semantic = vi.fn<ReplyServiceDependencies["personalContextUsageValidator"]>(
    async () => { throw new Error(privateFailure); },
  );

  const result = await generateReplies(
    { ...command, personalContextMode: "required" },
    dependencies(gateway, {
      contextProvider: {
        loadParticipantProfiles: async () => trustedFacts,
        load: async (_command, preloadedProfiles) => ({
          ...context,
          participantProfiles: preloadedProfiles ?? trustedFacts,
        }),
      },
      personalContextUsageValidator: semantic,
    }),
  );

  expect(result.kind).toBe("replies");
  if (result.kind !== "replies") return;
  expect(gateway.requests).toHaveLength(1);
  expect(result.candidates.map((candidate) => candidate.warnings)).toEqual([
    ["personal_context_reflection_unverified"],
    ["personal_context_reflection_unverified"],
    ["personal_context_reflection_unverified"],
  ]);
  expect(JSON.stringify(result)).not.toContain(privateFailure);
});
```

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
pnpm exec vitest run tests/integration/reply-service.test.ts
```

Expected: FAIL because weak reflection still retries, validator exceptions escape, and the new warnings do not exist.

- [ ] **Step 4: Implement candidate-aligned advisory handling**

Extend `ReplyWarning` in `src/domain/replies/reply-service.ts`:

```ts
  | "unverified_profile_context"
  | "personal_context_weakly_reflected"
  | "personal_context_reflection_unverified";
```

Inside each generation attempt, initialize:

```ts
let personalContextWarnings: [ReplyWarning[], ReplyWarning[], ReplyWarning[]] = [
  [],
  [],
  [],
];
```

Keep the invalid-basis branch unchanged. Replace the current `PERSONAL_CONTEXT_NOT_REFLECTED` retry block with:

```ts
try {
  const reflected = await this.dependencies.personalContextUsageValidator(
    semanticUsageCandidates([
      generated.candidates[0]!,
      generated.candidates[1]!,
      generated.candidates[2]!,
    ], evidenceProfiles),
    semanticUsageGrounding(command, validationContext),
  );
  personalContextWarnings = generated.candidates.map((candidate) => (
    reflected[candidate.strategy]
      ? []
      : ["personal_context_weakly_reflected" as const]
  )) as [ReplyWarning[], ReplyWarning[], ReplyWarning[]];
} catch {
  personalContextWarnings = [
    ["personal_context_reflection_unverified"],
    ["personal_context_reflection_unverified"],
    ["personal_context_reflection_unverified"],
  ];
}
```

Do not add a retry rule or log the caught error. Retain `PERSONAL_CONTEXT_NOT_REFLECTED` only as compatibility metadata if desired; production generation must not assign it.

Merge `...personalContextWarnings[index]` into each candidate's warnings in both successful return paths. At levels 6 and 7, retain `emotional_inference` and existing advisory warnings as well.

- [ ] **Step 5: Run service tests and verify GREEN**

```bash
pnpm exec vitest run tests/integration/reply-service.test.ts
```

Expected: PASS, including existing invalid-basis and normal-mode tests.

- [ ] **Step 6: Confirm the obsolete runtime assignment is gone**

```bash
rg -n 'validationRuleIds = \["PERSONAL_CONTEXT_NOT_REFLECTED"\]' src tests
```

Expected: no matches.

- [ ] **Step 7: Commit Task 1**

```bash
git add src/domain/replies/reply-service.ts tests/integration/reply-service.test.ts
git commit -m "fix: relax personal context reflection checks"
```

### Task 2: Render and preserve the new warnings

**Files:**
- Modify: `tests/unit/reply-results.test.tsx`
- Modify: `src/components/reply-results.tsx`
- Modify: `tests/integration/replies-route.test.ts`

**Interfaces:**
- Consumes: `ReplyCandidate.warnings: ReplyWarning[]` from Task 1.
- Produces: Korean copy in `warningLabels` and unchanged candidates at `ReplyRouteDependencies.persist`.

- [ ] **Step 1: Write a failing UI test**

Add to `tests/unit/reply-results.test.tsx`:

```tsx
test("shows advisory personal-context reflection notices", () => {
  render(<ReplyResults candidates={[
    { ...candidates[0], warnings: ["personal_context_weakly_reflected"] },
    { ...candidates[1], warnings: ["personal_context_reflection_unverified"] },
  ]} />);

  expect(screen.getByText(
    "개인 컨텍스트가 약하게 반영됐을 수 있어요.",
  )).toBeVisible();
  expect(screen.getByText(
    "개인 컨텍스트 반영 여부를 확인하지 못했어요.",
  )).toBeVisible();
});
```

- [ ] **Step 2: Run the UI test and verify RED**

```bash
pnpm exec vitest run tests/unit/reply-results.test.tsx
```

Expected: FAIL because `warningLabels` lacks the new identifiers.

- [ ] **Step 3: Add exact Korean labels**

Extend `warningLabels` in `src/components/reply-results.tsx`:

```ts
personal_context_weakly_reflected: "개인 컨텍스트가 약하게 반영됐을 수 있어요.",
personal_context_reflection_unverified: "개인 컨텍스트 반영 여부를 확인하지 못했어요.",
```

- [ ] **Step 4: Verify UI GREEN**

```bash
pnpm exec vitest run tests/unit/reply-results.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Add the persistence-boundary regression**

In `tests/integration/replies-route.test.ts`, add:

```ts
test("passes personal-context advisory warnings unchanged to persistence", async () => {
  const warningCandidates: [ReplyCandidate, ReplyCandidate, ReplyCandidate] = [
    { ...candidates[0], warnings: ["personal_context_weakly_reflected"] },
    { ...candidates[1], warnings: ["personal_context_reflection_unverified"] },
    candidates[2],
  ];
  const deps = dependencies({
    generate: vi.fn(async () => ({
      kind: "replies" as const,
      candidates: warningCandidates,
    })),
  });

  const response = await createReplyPostHandler(deps)(request(validBody({
    personalContextMode: "required",
  })));

  expect(response.status).toBe(200);
  expect(deps.persist).toHaveBeenCalledWith(expect.objectContaining({
    candidates: warningCandidates,
  }));
  expect(deps.log).not.toHaveBeenCalled();
});
```

This proves the route hands warnings to the existing adapter, which encrypts `candidate.warnings` into `replyCandidates.encryptedWarnings`.

- [ ] **Step 6: Run focused UI and route verification**

```bash
pnpm exec vitest run tests/unit/reply-results.test.tsx tests/integration/replies-route.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

```bash
git add src/components/reply-results.tsx tests/unit/reply-results.test.tsx tests/integration/replies-route.test.ts
git commit -m "feat: show personal context reflection warnings"
```

### Task 3: Full verification and report

**Files:**
- Create: `docs/superpowers/reports/2026-08-12-relaxed-personal-context-validation.md`

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: reproducible verification evidence and deployment handoff notes.

- [ ] **Step 1: Run focused verification**

```bash
pnpm exec vitest run \
  tests/integration/reply-service.test.ts \
  tests/unit/reply-results.test.tsx \
  tests/integration/replies-route.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run all unit tests**

```bash
pnpm exec vitest run tests/unit
```

Expected: PASS.

- [ ] **Step 3: Run all integration tests**

```bash
pnpm exec vitest run tests/integration
```

Expected: PASS.

- [ ] **Step 4: Run typecheck and build sequentially**

```bash
pnpm exec tsc --noEmit
pnpm build
```

Expected: both exit 0. Keep them sequential because Next build rewrites `.next/types`.

- [ ] **Step 5: Run privacy and scope scans**

```bash
rg -n 'PRIVATE_VALIDATOR_PAYLOAD|PRIVATE_TRUSTED_VALUE|PRIVATE_REJECTED_SEMANTIC_TEXT' src || true
rg -n 'validationRuleIds = \["PERSONAL_CONTEXT_NOT_REFLECTED"\]' src tests || true
git diff --check
git status --short
```

Expected: no private fixture markers or obsolete runtime assignment in `src`; diff check clean; `.env.local` remains untracked and unstaged.

- [ ] **Step 6: Write the implementation report**

Create `docs/superpowers/reports/2026-08-12-relaxed-personal-context-validation.md`:

```md
# Relaxed personal-context validation implementation report

## Delivered behavior

- Weak semantic reflection returns three candidates with candidate-level warnings.
- Semantic-validator failure returns three candidates with unverified warnings.
- Required basis IDs and all existing mandatory validation remain enforced.

## TDD evidence

- RED: <focused command and observed failing assertions>
- GREEN: <focused command and observed passing count>

## Final verification

- Focused: <observed result>
- Unit: <observed result>
- Integration: <observed result>
- TypeScript: <observed result>
- Production build: <observed result>
- Privacy/scope scans: <observed result>

## Accepted trade-off

Every semantic false result is advisory by explicit product choice; independent deterministic validation remains active.
```

Replace every angle-bracket field with actual observed output before committing.

- [ ] **Step 7: Review the scoped diff**

```bash
git diff --check
git diff --stat HEAD~2
git status --short
```

Expected: only planned files plus the report changed; `.env.local` is not staged.

- [ ] **Step 8: Commit the report**

```bash
git add docs/superpowers/reports/2026-08-12-relaxed-personal-context-validation.md
git commit -m "docs: verify relaxed personal context validation"
```

- [ ] **Step 9: Confirm final repository state**

```bash
git status --short
git log -4 --oneline
```

Expected: only the pre-existing untracked `.env.local` appears; implementation commits are at the tip of `main`. Do not push unless the user explicitly requests it.
