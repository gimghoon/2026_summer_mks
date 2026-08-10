# Reply JSON Schema Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make reply generation use an OpenAI-compatible JSON Schema while preserving exactly three candidates in the required strategy order.

**Architecture:** The provider-facing Zod schema becomes a fixed-length homogeneous array whose candidate strategy is an enum. `ReplyService` then enforces the stronger ordered-strategy tuple contract before candidate policy validation and persistence, using the existing opaque `OUTPUT_STRUCTURE` retry path.

**Tech Stack:** TypeScript, Zod 4, OpenAI Responses API, Vitest

## Global Constraints

- Keep the API response shape as `{ candidates: [...] }` with exactly three candidates.
- Keep the exact order `relationship_soft`, `emotion_signal`, `clearer_request`.
- Do not change prompts, style policy, retrieval, persistence, or database schema.
- Do not expose prompt, conversation, candidate, or provider response text in errors or logs.
- Retry invalid output at most once using only `OUTPUT_STRUCTURE`.

---

### Task 1: Use a Provider-Compatible Candidate Array

**Files:**
- Modify: `src/domain/replies/reply-service.ts`
- Test: `tests/integration/reply-service.test.ts`

**Interfaces:**
- Consumes: `ModelGateway.extract<T>(request: StructuredModelRequest<T>): Promise<T>` and the existing `strategyOrder` constant.
- Produces: `generatedReplySchema` with a homogeneous three-item candidate array and ordered validation before the existing `[ReplyCandidate, ReplyCandidate, ReplyCandidate]` cast.

- [ ] **Step 1: Write failing provider-schema and order tests**

Add a test gateway that records the `StructuredModelRequest` passed to `extract`. Add this assertion for a valid generation call:

```ts
const request = gateway.extract.mock.calls[0]![0];
const jsonSchema = z.toJSONSchema(request.schema, { target: "draft-7" });
const candidates = (jsonSchema.properties as Record<string, unknown>).candidates as {
  type: string;
  items: unknown;
  minItems: number;
  maxItems: number;
};
expect(candidates.type).toBe("array");
expect(Array.isArray(candidates.items)).toBe(false);
expect(candidates).toMatchObject({ minItems: 3, maxItems: 3 });
```

Add a second test whose gateway returns the same three candidates in the wrong order twice:

```ts
await expect(generateReplies(command, dependencies)).rejects.toMatchObject({
  name: "ReplyGenerationValidationError",
  ruleIds: ["OUTPUT_STRUCTURE"],
});
expect(gateway.extract).toHaveBeenCalledTimes(2);
expect(gateway.extract.mock.calls[1]![0].input).toContain("OUTPUT_STRUCTURE");
```

- [ ] **Step 2: Run the two tests and verify RED**

Run:

```bash
pnpm exec vitest run tests/integration/reply-service.test.ts
```

Expected: the provider-schema test fails because tuple JSON Schema emits tuple-style items, and the wrong-order test fails because the service currently accepts the cast without checking strategy order.

- [ ] **Step 3: Replace the tuple schema with a fixed-length homogeneous array**

In `src/domain/replies/reply-service.ts`, define one candidate schema and use it for the provider-facing array:

```ts
const generatedCandidateSchema = z.object({
  strategy: z.enum(strategyOrder),
  ...candidateFields,
});

const generatedReplySchema = z.object({
  candidates: z.array(generatedCandidateSchema).length(3),
});
```

Add the explicit ordered check:

```ts
function hasExpectedStrategyOrder(candidates: GeneratedReply["candidates"]): boolean {
  return candidates.every((candidate, index) => candidate.strategy === strategyOrder[index]);
}
```

Immediately after extraction and before casting or candidate policy validation, route a wrong order through the existing retry behavior:

```ts
if (!hasExpectedStrategyOrder(generated.candidates)) {
  validationRuleIds = ["OUTPUT_STRUCTURE"];
  if (attempt === 0) continue;
  throw new ReplyGenerationValidationError(validationRuleIds);
}
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
pnpm exec vitest run tests/integration/reply-service.test.ts tests/unit/model-gateway.test.ts
```

Expected: all focused tests pass; the captured schema uses one object under `items`, and wrong order retries once then rejects.

- [ ] **Step 5: Run complete verification**

Run sequentially:

```bash
pnpm exec tsc --noEmit
pnpm test
pnpm test:integration
pnpm build
git diff --check
```

Expected: every command exits `0` with no new warnings attributable to this change.

- [ ] **Step 6: Commit the bug fix**

```bash
git add src/domain/replies/reply-service.ts tests/integration/reply-service.test.ts
git commit -m "fix: use compatible reply output schema"
```
