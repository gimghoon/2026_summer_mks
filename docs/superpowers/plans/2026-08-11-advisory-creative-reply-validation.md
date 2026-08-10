# 6·7단계 권고형 답장 검증 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 강도 6·7에서는 콘텐츠 검증 결과를 후보별 주의 배지로 반환하고, 각 답장에 검증된 퍼스널 컨텍스트 근거를 표시하면서 1~5단계의 엄격한 검증을 유지한다.

**Architecture:** 생성 모델은 서버가 만든 근거 ID 목록에서 후보당 최대 2개를 선택한다. 서버는 후보별 검증 결과를 계산해 1~5단계에서는 기존 오류 흐름에 사용하고 6~7단계에서는 고정된 `ReplyWarning`으로 변환한다. 공개 후보의 근거와 경고는 API·암호화 저장소·카드 UI까지 그대로 전달하되 복사 본문에는 포함하지 않는다.

**Tech Stack:** Next.js 15 App Router, TypeScript, React 19, Zod, Drizzle ORM/PostgreSQL, Vitest, Testing Library

## Global Constraints

- 1~5단계의 현재 콘텐츠 차단과 한 번 재시도 동작을 유지한다.
- 6~7단계는 정확히 세 후보와 전략 순서를 읽을 수 없는 구조 오류만 차단한다.
- 6~7단계의 콘텐츠 검증 위반은 재생성 또는 500이 아니라 후보별 경고가 된다.
- 모델 프롬프트에는 사실 창작, 모순, 강요, 관계 위반, 중요 의도 모호성을 계속 피하라고 지시한다.
- 퍼스널 근거는 `participantProfiles`에서만 만들고 실제 원문 메시지를 UI에 인용하지 않는다.
- 모델이 반환한 근거 ID는 서버 허용 목록과 대조하고, 후보당 최대 2개만 공개한다.
- 근거와 경고는 데이터베이스에 암호화해 저장하며 기존 행 호환을 위해 새 컬럼은 nullable이다.
- `.env.local`을 읽어 출력하거나 수정하거나 스테이징하지 않는다.
- 검증 중 실제 OpenAI API를 호출하지 않는다.

---

### Task 1: 퍼스널 컨텍스트 근거와 공개 후보 계약

**Files:**
- Create: `src/domain/replies/reply-evidence.ts`
- Modify: `src/domain/replies/reply-service.ts`
- Create: `tests/unit/reply-evidence.test.ts`
- Modify: `tests/integration/reply-service.test.ts`
- Modify: `tests/integration/production-reply-context.test.ts`
- Modify: `tests/integration/reply-production-policy.test.ts`
- Modify: `tests/integration/replies-route.test.ts`
- Modify: `src/domain/testing/e2e-fixture-store.ts`

**Interfaces:**
- Produces: `PersonalContextEvidence`, `NO_PERSONAL_CONTEXT_BASIS`, `buildPersonalContextEvidence(profiles)`, `resolveContextBasis(ids, evidence)` from `reply-evidence.ts`.
- Produces: `ReplyCandidateContent` for model/fact-validation fields, plus public `ReplyWarning` and `ReplyCandidate` metadata fields from `reply-service.ts`.
- Produces: model-only `contextBasisIds: string[]` constrained to at most 2 IDs.
- Consumes: existing `ParticipantProfileContext` values, conditions, and exceptions.

- [ ] **Step 1: Write failing evidence tests**

Create `tests/unit/reply-evidence.test.ts` with these cases:

```ts
import {
  NO_PERSONAL_CONTEXT_BASIS,
  buildPersonalContextEvidence,
  resolveContextBasis,
} from "@/domain/replies/reply-evidence";

test("builds bounded summaries without raw conversation quotes", () => {
  const evidence = buildPersonalContextEvidence([{
    kind: "tone",
    value: "짧은 문장과 장난스러운 반응을 자주 사용함",
    conditions: ["친한 친구와 대화할 때"],
    exceptions: ["갈등 상황"],
  }]);
  expect(evidence).toEqual([expect.objectContaining({
    id: "profile-0",
    summary: expect.stringContaining("tone: 짧은 문장"),
  })]);
  expect(evidence[0]!.summary.length).toBeLessThanOrEqual(120);
});

test("resolves only known unique ids and caps the result at two", () => {
  const evidence = buildPersonalContextEvidence([
    { kind: "tone", value: "짧게 답함" },
    { kind: "reaction", value: "장난스럽게 반응함" },
    { kind: "pace", value: "빠르게 답함" },
  ]);
  expect(resolveContextBasis(["profile-1", "invented", "profile-1", "profile-0", "profile-2"], evidence))
    .toEqual([evidence[1]!.summary, evidence[0]!.summary]);
});

test("returns the fixed fallback when no supplied id is valid", () => {
  expect(resolveContextBasis(["invented"], [])).toEqual([NO_PERSONAL_CONTEXT_BASIS]);
});
```

- [ ] **Step 2: Run the evidence tests and verify RED**

Run:

```bash
pnpm exec vitest run tests/unit/reply-evidence.test.ts
```

Expected: FAIL because `reply-evidence.ts` does not exist.

- [ ] **Step 3: Implement the evidence boundary**

Create `src/domain/replies/reply-evidence.ts` with these exact exports:

```ts
export type ProfileEvidenceInput = {
  kind: string;
  value: string;
  conditions?: string[];
  exceptions?: string[];
};

export type PersonalContextEvidence = { id: string; summary: string };
export const NO_PERSONAL_CONTEXT_BASIS = "현재 상황과 답장 의도만 사용";

export function buildPersonalContextEvidence(
  profiles: ProfileEvidenceInput[],
): PersonalContextEvidence[];

export function resolveContextBasis(
  ids: string[],
  evidence: PersonalContextEvidence[],
): string[];
```

`buildPersonalContextEvidence` must format each entry as `종류: 값 · 조건: ... · 예외: ...`, omit empty sections, normalize whitespace, truncate to 120 Unicode code points, and assign `profile-${index}`. `resolveContextBasis` must discard unknown/duplicate IDs, preserve model order, return at most two summaries, and return the fixed fallback when none remain.

- [ ] **Step 4: Add metadata to the generation contract**

In `src/domain/replies/reply-service.ts`:

```ts
export type ReplyWarning =
  | "emotional_inference"
  | "duplicate_text"
  | "relationship_boundary"
  | "agency_or_safety"
  | "personal_style_mismatch"
  | "specific_fact_inference"
  | "profile_conflict"
  | "important_intent_ambiguity";

export type ReplyCandidateContent = {
  strategy: ReplyStrategy;
  text: string;
  intentLabel: string;
  riskLabel: string | null;
};

export type ReplyCandidate = ReplyCandidateContent & {
  contextBasis: string[];
  warnings: ReplyWarning[];
};
```

Change `ReplyFactValidator` to accept `ReplyCandidateContent`, because persistence/UI metadata is irrelevant to fact checking. Add `contextBasisIds: z.array(z.string().trim().min(1).max(80)).max(2)` to the model-only candidate schema. Build the evidence list before the model request, include it as `personalContextEvidence`, and resolve IDs into `contextBasis` before returning public candidates. For this task, initialize `warnings` to an empty array; Task 2 replaces that temporary value with validation-derived values.

Update model-response fixtures in `reply-service.test.ts`, `production-reply-context.test.ts`, and `reply-production-policy.test.ts` so every generated candidate includes `contextBasisIds: []`. Direct `validatesReplyFact` tests continue using `ReplyCandidateContent` and do not need display metadata. Assert a known ID resolves while an invented ID produces the fallback.

Update the public `ReplyCandidate` fixtures in `replies-route.test.ts` and `e2e-fixture-store.ts` with `contextBasis: [NO_PERSONAL_CONTEXT_BASIS]` and `warnings: []` so the repository remains type-correct at the end of Task 1. Task 3 will replace the fixture fallback with representative persisted metadata.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
pnpm exec vitest run tests/unit/reply-evidence.test.ts tests/integration/reply-service.test.ts tests/integration/production-reply-context.test.ts tests/integration/reply-production-policy.test.ts tests/integration/replies-route.test.ts
pnpm exec tsc --noEmit
```

Expected: all tests PASS and TypeScript exits 0.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/domain/replies/reply-evidence.ts src/domain/replies/reply-service.ts src/domain/testing/e2e-fixture-store.ts tests/unit/reply-evidence.test.ts tests/integration/reply-service.test.ts tests/integration/production-reply-context.test.ts tests/integration/reply-production-policy.test.ts tests/integration/replies-route.test.ts
git commit -m "feat: attach verified context basis to replies"
```

---

### Task 2: 6·7단계 권고형 콘텐츠 검증

**Files:**
- Create: `src/domain/replies/protected-intent.ts`
- Modify: `src/domain/replies/style-policy.ts`
- Modify: `src/domain/replies/reply-service.ts`
- Create: `tests/unit/protected-intent.test.ts`
- Modify: `tests/unit/style-policy.test.ts`
- Modify: `tests/integration/reply-service.test.ts`

**Interfaces:**
- Produces: `protectedIntentKind(intent): "money" | "consent" | "safety" | "refusal" | "promise" | null`.
- Produces: candidate-aligned `CandidateValidationResult[]`, where each result is `{ ruleIds: ReplyValidationRuleId[] }`.
- Produces: `warningForRule(ruleId): ReplyWarning` for every content rule except `OUTPUT_STRUCTURE`.
- Consumes: Task 1 public candidate metadata and evidence resolution.

- [ ] **Step 1: Write RED tests for protected financial decisions**

Create `tests/unit/protected-intent.test.ts`:

```ts
import { protectedIntentKind } from "@/domain/replies/protected-intent";

test("does not treat a completed payment praise as a protected money decision", () => {
  expect(protectedIntentKind("민서가 돈 보낸 거를 토대로 칭찬 아닌 칭찬을 하고 싶어")).toBeNull();
});

test.each([
  "돈을 보내 달라고 요청하고 싶어",
  "이번 송금은 거절하고 싶어",
  "금액을 확인하고 입금하겠다고 말하고 싶어",
  "공동 비용은 걷고 개인 쇼핑은 각자 내자고 말하고 싶어",
])("recognizes a real protected money decision: %s", (intent) => {
  expect(protectedIntentKind(intent)).toBe("money");
});
```

Add style-policy assertions that the praise intent yields `mustRemainExplicit: false` and the four real decisions yield `true`.

- [ ] **Step 2: Write RED tests for advisory level 6·7 validation**

In `tests/integration/reply-service.test.ts`, add table-driven cases for levels 6 and 7. Feed one model response containing content that collectively triggers `UNSUPPORTED_PERSONAL_DEVICE`, `EXPLICIT_INTENT_AMBIGUOUS`, `FACT_CONTRADICTION`, `RELATIONSHIP_FORBIDDEN_CUE`, `AGENCY_OR_SAFETY_VIOLATION`, `UNSUPPORTED_SPECIFIC_FACT`, and `DUPLICATE_TEXT`. Use two copies of that response only in the separate level-5 retry test.

Assert:

```ts
expect(result).toMatchObject({ kind: "replies" });
expect(gateway.requests).toHaveLength(1);
expect(result.candidates[0]!.warnings).toContain("emotional_inference");
expect(result.candidates.flatMap((candidate) => candidate.warnings)).toEqual(expect.arrayContaining([
  "personal_style_mismatch",
  "important_intent_ambiguity",
]));
```

Retain one level-5 case with the same invalid response and assert that it retries once and then rejects with the original opaque rule IDs.

- [ ] **Step 3: Run the new tests and verify RED**

Run:

```bash
pnpm exec vitest run tests/unit/protected-intent.test.ts tests/unit/style-policy.test.ts tests/integration/reply-service.test.ts
```

Expected: FAIL because the protected-decision classifier and advisory warnings are not implemented.

- [ ] **Step 4: Implement the protected-decision classifier**

Create `src/domain/replies/protected-intent.ts`. Preserve the existing consent, safety, refusal, and important-promise categories. For money, require both a money noun and a decision cue. Decision cues must cover request (`요청`, `부탁`, `보내 달`, `입금해 줘`), refusal (`거절`, `거부`, `안 보낼`, `못 빌려`), acceptance (`보낼게`, `입금할게`, `갚을게`, `빌려줄게`), or allocation (`걷자`, `정산하자`, `각자 내`, `각자 부담`). A completed-payment praise containing only `돈 보낸 거`, `칭찬`, or `고맙` must return `null`.

Change `style-policy.ts:isExplicitIntent` to return `protectedIntentKind(intent) !== null`. Change `reply-service.ts:explicitIntentKind` to use the same classifier so policy selection and candidate validation cannot disagree.

- [ ] **Step 5: Refactor validation to candidate-aligned results**

Change `validateCandidates` to return one result per candidate:

```ts
type CandidateValidationResult = { ruleIds: ReplyValidationRuleId[] };

async function validateCandidates(...): Promise<CandidateValidationResult[]>;
```

Add duplicate warnings to every candidate whose normalized text appears more than once. Add all other rule IDs only to the candidate that violates the rule. Provide a complete fixed map:

```ts
const warningByRule = {
  DUPLICATE_TEXT: "duplicate_text",
  RELATIONSHIP_FORBIDDEN_CUE: "relationship_boundary",
  AGENCY_OR_SAFETY_VIOLATION: "agency_or_safety",
  UNSUPPORTED_PERSONAL_DEVICE: "personal_style_mismatch",
  UNSUPPORTED_SPECIFIC_FACT: "specific_fact_inference",
  FACT_CONTRADICTION: "profile_conflict",
  EXPLICIT_INTENT_AMBIGUOUS: "important_intent_ambiguity",
} as const;
```

Do not map `OUTPUT_STRUCTURE`; it remains a hard error.

- [ ] **Step 6: Apply strict versus advisory modes**

In `ReplyService.generateReplies`:

- For levels 1~5, flatten and de-duplicate candidate rule IDs for the existing retry feedback. Retry once; reject after the second invalid response.
- For levels 6~7, return after the first structurally valid response. Resolve each candidate's content rules to warnings and prepend `emotional_inference`. Do not retry because of content rules.
- Continue retrying once for schema parsing and strategy-order failures at every level.
- Continue telling the model to avoid every existing unsafe, invented, contradictory, or relationship-forbidden cue.

- [ ] **Step 7: Run focused tests and typecheck**

Run:

```bash
pnpm exec vitest run tests/unit/protected-intent.test.ts tests/unit/style-policy.test.ts tests/integration/reply-service.test.ts tests/integration/reply-production-policy.test.ts
pnpm exec tsc --noEmit
```

Expected: all tests PASS; level 6·7 content violations return warnings; level 1~5 behavior remains strict.

- [ ] **Step 8: Commit Task 2**

```bash
git add src/domain/replies/protected-intent.ts src/domain/replies/style-policy.ts src/domain/replies/reply-service.ts tests/unit/protected-intent.test.ts tests/unit/style-policy.test.ts tests/integration/reply-service.test.ts tests/integration/reply-production-policy.test.ts
git commit -m "feat: make creative reply validation advisory"
```

---

### Task 3: 근거·경고 암호화 저장과 API 호환

**Files:**
- Modify: `src/db/schema.ts`
- Create: `src/db/migrations/0004_advisory_reply_metadata.sql`
- Create: `src/db/migrations/meta/0004_snapshot.json` using Drizzle Kit
- Modify: `src/db/migrations/meta/_journal.json` using Drizzle Kit
- Modify: `src/app/api/replies/route.ts`
- Modify: `src/domain/testing/e2e-fixture-store.ts`
- Modify: `tests/unit/schema-contract.test.ts`
- Modify: `tests/integration/replies-route.test.ts`

**Interfaces:**
- Consumes: Task 1 `ReplyCandidate.contextBasis` and `ReplyCandidate.warnings`.
- Produces: nullable `replyCandidates.encryptedContextBasis` and `replyCandidates.encryptedWarnings` text columns.
- Preserves: `/api/replies` response shape `{ candidates: ReplyCandidate[] }` and encrypted-at-rest policy.

- [ ] **Step 1: Write RED schema and API tests**

Extend `tests/unit/schema-contract.test.ts`:

```ts
expect(Object.keys(getTableColumns(replyCandidates))).toEqual(expect.arrayContaining([
  "encryptedContextBasis",
  "encryptedWarnings",
]));
expect(readFileSync("src/db/migrations/0004_advisory_reply_metadata.sql", "utf8"))
  .toMatch(/ADD COLUMN "encrypted_context_basis" text/iu);
```

Extend the reply-route candidate fixture with `contextBasis` and `warnings`. Assert the 200 response and the object passed to `persist` preserve both arrays exactly.

- [ ] **Step 2: Run schema and route tests and verify RED**

```bash
pnpm exec vitest run tests/unit/schema-contract.test.ts tests/integration/replies-route.test.ts
```

Expected: FAIL because the columns and migration do not exist and fixtures lack the new required fields.

- [ ] **Step 3: Add schema columns and generate the migration**

Add to `replyCandidates`:

```ts
encryptedContextBasis: text("encrypted_context_basis"),
encryptedWarnings: text("encrypted_warnings"),
```

Generate Drizzle metadata:

```bash
pnpm exec drizzle-kit generate --name advisory_reply_metadata
```

Verify the generated SQL adds both nullable text columns and the journal tag is `0004_advisory_reply_metadata`. Do not hand-edit the generated snapshot.

- [ ] **Step 4: Encrypt metadata during production persistence**

In `src/app/api/replies/route.ts`, add:

```ts
encryptedContextBasis: encryptJson(candidate.contextBasis),
encryptedWarnings: encryptJson(candidate.warnings),
```

No plaintext candidate basis or warnings may be inserted. Update fixture candidates to include deterministic metadata, such as `contextBasis: ["말투: 짧고 부드럽게 답함"]` and level-appropriate warnings, so E2E fixture responses remain contract-compatible.

- [ ] **Step 5: Run focused schema/API verification**

```bash
pnpm exec vitest run tests/unit/schema-contract.test.ts tests/integration/replies-route.test.ts
pnpm exec drizzle-kit check --config=drizzle.config.ts
pnpm exec tsc --noEmit
```

Expected: tests PASS, Drizzle reports a valid schema, and TypeScript exits 0.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/db/schema.ts src/db/migrations src/app/api/replies/route.ts src/domain/testing/e2e-fixture-store.ts tests/unit/schema-contract.test.ts tests/integration/replies-route.test.ts
git commit -m "feat: persist encrypted reply evidence and warnings"
```

---

### Task 4: 답장 카드 근거와 주의 배지 UI

**Files:**
- Modify: `src/components/reply-results.tsx`
- Modify: `src/app/globals.css`
- Modify: `tests/unit/reply-results.test.tsx`
- Modify: `tests/unit/reply-composer.test.tsx`

**Interfaces:**
- Consumes: `ReplyCandidate.contextBasis` and `ReplyCandidate.warnings` from the API.
- Produces: per-card `퍼스널 컨텍스트 근거` list and fixed Korean warning badges.
- Preserves: editing state and clipboard payload containing only `candidate.text`.

- [ ] **Step 1: Write failing card tests**

Update the test fixture:

```ts
{
  strategy: "relationship_soft",
  text: "처음 문장",
  intentLabel: "관계",
  riskLabel: null,
  contextBasis: ["말투: 짧은 문장을 자주 사용함"],
  warnings: ["emotional_inference", "personal_style_mismatch"],
}
```

Add assertions:

```ts
expect(screen.getByText("퍼스널 컨텍스트 근거")).toBeVisible();
expect(screen.getByText("말투: 짧은 문장을 자주 사용함")).toBeVisible();
expect(screen.getByText("감정 해석 포함")).toBeVisible();
expect(screen.getByText("평소 말투와 다를 수 있음")).toBeVisible();
expect(screen.getByText(/보내기 전에 실제 의도와 맞는지 확인/)).toBeVisible();
```

Keep the existing edit-and-copy test and assert `navigator.clipboard.writeText` receives only the edited reply text, not the context basis or warning copy.

- [ ] **Step 2: Run UI tests and verify RED**

```bash
pnpm exec vitest run tests/unit/reply-results.test.tsx tests/unit/reply-composer.test.tsx
```

Expected: FAIL because the metadata UI is absent and local candidate types lack required fields.

- [ ] **Step 3: Render verified basis and warnings**

Import the domain `ReplyCandidate` type instead of maintaining a divergent component-local shape. Add a fixed exhaustive label map:

```ts
const warningLabels: Record<ReplyWarning, string> = {
  emotional_inference: "감정 해석 포함",
  duplicate_text: "답장 간 표현 유사",
  relationship_boundary: "관계 범위 주의",
  agency_or_safety: "갈등·안전 주의",
  personal_style_mismatch: "평소 말투와 다를 수 있음",
  specific_fact_inference: "사실 추측 포함",
  profile_conflict: "프로필과 다를 수 있음",
  important_intent_ambiguity: "중요 의도 불명확",
};
```

Render at most two basis summaries in the existing `<dl>`, then render deduplicated warning badges. Render the fixed emotional-inference explanation only when that warning is present. Do not concatenate metadata into `candidate.text` or the clipboard function.

- [ ] **Step 4: Add responsive card styles**

In `src/app/globals.css`, add scoped `.context-basis`, `.warning-list`, `.warning-badge`, and `.interpretation-note` rules. Keep badges wrapping within the existing mobile card width and preserve 44px action controls and visible focus styles.

- [ ] **Step 5: Run focused UI and type verification**

```bash
pnpm exec vitest run tests/unit/reply-results.test.tsx tests/unit/reply-composer.test.tsx tests/unit/app-shell.test.tsx
pnpm exec tsc --noEmit
```

Expected: all tests PASS and TypeScript exits 0.

- [ ] **Step 6: Commit Task 4**

```bash
git add src/components/reply-results.tsx src/app/globals.css tests/unit/reply-results.test.tsx tests/unit/reply-composer.test.tsx
git commit -m "feat: show reply context basis and warnings"
```

---

### Task 5: Full verification and implementation review

**Files:**
- Review: all files changed by Tasks 1~4
- Modify only if verification reveals a scoped defect.

**Interfaces:**
- Verifies the complete domain → API → encrypted persistence → UI flow.
- Produces no new feature contract.

- [ ] **Step 1: Run the focused regression matrix**

```bash
pnpm exec vitest run \
  tests/unit/reply-evidence.test.ts \
  tests/unit/protected-intent.test.ts \
  tests/unit/style-policy.test.ts \
  tests/unit/reply-results.test.tsx \
  tests/unit/reply-composer.test.tsx \
  tests/unit/schema-contract.test.ts \
  tests/integration/reply-service.test.ts \
  tests/integration/reply-production-policy.test.ts \
  tests/integration/replies-route.test.ts
```

Expected: all focused tests PASS with zero failures.

- [ ] **Step 2: Run full local verification**

Run sequentially from the isolated worktree so an active main-tree dev server cannot race with `.next`:

```bash
pnpm test
pnpm test:integration
pnpm exec tsc --noEmit
pnpm exec drizzle-kit check --config=drizzle.config.ts
pnpm build
```

Expected: every command exits 0. Do not run Playwright or a live model call for this change.

- [ ] **Step 3: Perform privacy and diff checks**

```bash
git diff --check
git status --short
git diff --unified=0 main...HEAD -- src tests | rg '^\+.*console\.(log|debug)|^\+.*PRIVATE_CONVERSATION_TEXT|^\+.*OLDEST_PRIVATE_SENTINEL' || true
```

Expected: no whitespace errors, no unexpected files, and no new sensitive logging. `.env.local` must not be present in the worktree or staged set.

- [ ] **Step 4: Request independent code review**

Ask the reviewer to check:

- 1~5 strict versus 6~7 advisory branching
- candidate-specific warning attribution
- protected money decision classification
- invented evidence ID filtering
- encryption of both new fields
- UI copy isolation

Fix every Critical or Important finding with a failing regression test, rerun the focused matrix, and create a scoped fix commit.

- [ ] **Step 5: Record final evidence**

```bash
git log --oneline --decorate -8
git status --short
```

Expected: the feature branch contains the four task commits plus any reviewed fix commit, and the worktree is clean.
