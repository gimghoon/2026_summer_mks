# Reply Validation Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate usable replies for shared-versus-personal expense boundaries without permitting unsupported personal chat decorations.

**Architecture:** Extend the deterministic money-intent validator with one bounded allocation subtype that requires both halves of the user's decision in every candidate. Clarify the existing provider policy by mapping personal-device keys to visible symbols, while retaining the current validator, one-retry limit, generic API response, and safe opaque diagnostics.

**Tech Stack:** TypeScript, Zod, OpenAI Responses API, Vitest

## Global Constraints

- Preserve the existing money refusal, request, and acceptance behavior.
- Require both the shared-expense rule and the personal-expense rule in every allocation candidate.
- Do not globally allow `ㅋㅋ`, `ㅎㅎ`, repeated vowels, `~`, or emoji.
- Keep the existing one-retry limit and fail-closed behavior.
- Never log prompts, conversations, profile facts, or generated candidates.
- Keep browser API errors generic.

---

### Task 1: Preserve Opaque Validation Diagnostics

**Files:**
- Modify: `src/domain/replies/reply-api-handler.ts`
- Test: `tests/integration/replies-route.test.ts`

**Interfaces:**
- Consumes: `ReplyGenerationValidationError.ruleIds: ReplyValidationRuleId[]`.
- Produces: safe `failure` metadata formatted as `ReplyGenerationValidationError:<RULE>|<RULE>`.

- [ ] **Step 1: Verify the diagnostic regression is RED**

The route test must throw this error from the injected generator:

```ts
throw new ReplyGenerationValidationError([
  "UNSUPPORTED_PERSONAL_DEVICE",
  "FACT_CONTRADICTION",
]);
```

It must expect only opaque metadata:

```ts
expect(deps.log).toHaveBeenCalledWith("reply_request_failed", expect.objectContaining({
  failure: "ReplyGenerationValidationError:UNSUPPORTED_PERSONAL_DEVICE|FACT_CONTRADICTION",
}));
expect(JSON.stringify(deps.log.mock.calls)).not.toContain("PRIVATE_CONVERSATION_TEXT");
```

Run:

```bash
pnpm exec vitest run tests/integration/replies-route.test.ts
```

Expected before implementation: FAIL because only `ReplyGenerationValidationError` is logged.

- [ ] **Step 2: Implement the safe diagnostic category**

Import `ReplyGenerationValidationError` as a runtime value and classify only that error:

```ts
failure: error instanceof ReplyGenerationValidationError
  ? `${error.name}:${error.ruleIds.join("|")}`
  : error instanceof Error ? error.name : "unknown",
```

- [ ] **Step 3: Verify the route test is GREEN**

Run:

```bash
pnpm exec vitest run tests/integration/replies-route.test.ts
```

Expected: all route tests pass, with no private text in the mock log calls.

- [ ] **Step 4: Commit diagnostics**

```bash
git add src/domain/replies/reply-api-handler.ts tests/integration/replies-route.test.ts
git commit -m "fix: log opaque reply validation rules"
```

### Task 2: Support Money Allocation Boundaries

**Files:**
- Modify: `src/domain/replies/reply-service.ts`
- Test: `tests/integration/reply-service.test.ts`

**Interfaces:**
- Consumes: the normalized `GenerateRepliesCommand.intent`, candidate text, `StylePolicy.allowedDevices`, and existing `ReplyValidationRuleId` retry behavior.
- Produces: deterministic allocation preservation and a provider instruction that maps each personal-device key to its visible form.

- [ ] **Step 1: Write failing allocation and provider-instruction tests**

Add an allocation command:

```ts
const allocationCommand = {
  ...command,
  intent: "같이 하는 활동은 돈을 한번에 걷되 개인적인 쇼핑은 알아서 쓰는 거를 말하고 싶어",
};
```

Prove a faithful candidate set succeeds on the first attempt:

```ts
const gateway = new FakeGateway([candidates([
  "같이 하는 활동비는 한 번에 걷고 개인 쇼핑은 각자 부담하는 걸로 하자",
  "공동으로 쓰는 돈은 모아서 정산하고 쇼핑 비용은 각자 내면 좋겠어",
  "활동 비용은 같이 걷고 개인적으로 사는 건 각자 알아서 쓰자",
])]);
await expect(generateReplies(allocationCommand, dependencies(gateway)))
  .resolves.toMatchObject({ kind: "replies" });
expect(gateway.requests).toHaveLength(1);
```

Prove a candidate that omits the personal-expense half retries and then fails:

```ts
const incomplete = candidates([
  "같이 하는 활동비는 한 번에 걷자",
  "공동 비용은 모아서 정산하자",
  "활동 비용은 같이 내자",
]);
const gateway = new FakeGateway([incomplete, incomplete]);
await expect(generateReplies(allocationCommand, dependencies(gateway))).rejects.toMatchObject({
  ruleIds: ["EXPLICIT_INTENT_AMBIGUOUS"],
});
expect(JSON.parse(gateway.requests[1]!.input).validationRuleIds)
  .toEqual(["EXPLICIT_INTENT_AMBIGUOUS"]);
```

On a normal generation request, assert the provider instruction contains all four mappings and the conditional prohibition:

```ts
expect(gateway.requests[0]!.system).toContain("laughter=ㅋㅋ/ㅎㅎ");
expect(gateway.requests[0]!.system).toContain("tilde=~");
expect(gateway.requests[0]!.system).toContain("emoji=emoji");
expect(gateway.requests[0]!.system).toContain("only if its key is listed in Policy.allowedDevices");
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm exec vitest run tests/integration/reply-service.test.ts
```

Expected: the faithful allocation is rejected with `EXPLICIT_INTENT_AMBIGUOUS`, and the provider instruction lacks the concrete device mapping.

- [ ] **Step 3: Add bounded allocation detection and preservation**

In `src/domain/replies/reply-service.ts`, add helpers that require a shared-expense concept and a personal-expense concept in the intent:

```ts
function isMoneyAllocationIntent(intent: string): boolean {
  return /같이|공동|모임|활동/u.test(intent)
    && /개인|각자|알아서|쇼핑/u.test(intent)
    && /돈|비용|회비|정산|걷/u.test(intent);
}

function preservesMoneyAllocation(text: string): boolean {
  const shared = /(?:같이|공동|모임|활동|공금).{0,20}(?:한\s*번에|모아|걷|정산|같이\s*내)|(?:한\s*번에|모아|걷|정산).{0,20}(?:같이|공동|모임|활동|공금)/u.test(text);
  const personal = /(?:개인|각자|쇼핑).{0,20}(?:각자|알아서|따로|본인|부담|쓰|내)|(?:각자|알아서|따로|본인).{0,20}(?:개인|쇼핑|비용|돈)/u.test(text);
  return shared && personal;
}
```

At the start of the existing money branch, return the allocation result when the intent matches:

```ts
if (isMoneyAllocationIntent(normalizedIntent)) {
  return preservesMoneyAllocation(text);
}
```

- [ ] **Step 4: Clarify personal-device provider instructions**

Add this sentence to `generationSystem(policy)` before the serialized policy:

```ts
"Personal device mapping: laughter=ㅋㅋ/ㅎㅎ, vowel_repetition=repeated Korean vowels, tilde=~, emoji=emoji. Use a personal device only if its key is listed in Policy.allowedDevices.",
```

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
pnpm exec vitest run tests/integration/reply-service.test.ts tests/integration/replies-route.test.ts tests/unit/style-policy.test.ts
```

Expected: all focused tests pass; faithful allocation succeeds once, incomplete allocation retries once and fails closed, and unsupported-device validation remains active.

- [ ] **Step 6: Run complete verification**

Run sequentially:

```bash
pnpm exec tsc --noEmit
pnpm test
pnpm test:integration
pnpm build
git diff --check
```

Expected: every command exits `0`.

- [ ] **Step 7: Commit validation alignment**

```bash
git add src/domain/replies/reply-service.ts tests/integration/reply-service.test.ts
git commit -m "fix: preserve shared expense boundaries"
```
