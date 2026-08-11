# Required personal context mode implementation report

## Tasks 1–4 RED/GREEN evidence

### Task 1 — eligible evidence and stable basis IDs

- RED: `pnpm exec vitest run tests/unit/required-personal-context.test.ts tests/unit/reply-evidence.test.ts` exited 1. Three evidence assertions failed because IDs were positional, and the selector module import was unresolved.
- GREEN: the same command exited 0 with 2 files and 7 tests passed.
- Focused regression: `pnpm exec vitest run tests/unit/required-personal-context.test.ts tests/unit/reply-evidence.test.ts tests/integration/reply-service.test.ts tests/integration/production-reply-context.test.ts tests/integration/reply-production-policy.test.ts` exited 0 with 5 files and 77 tests passed; `pnpm exec tsc --noEmit` exited 0.
- Full verification at the Task 1 commit: `pnpm test` passed 28 files / 166 tests; `pnpm run test:integration` passed 13 files / 132 tests; `git diff --check` exited 0.

### Task 2 — required evidence and batched semantic reflection

- RED: `pnpm exec vitest run tests/integration/reply-service.test.ts` exited 1 with 9 failed / 47 passed (56 total). The intended failures covered no-fact preflight, basis retry, semantic validation, inference warning, and second semantic failure handling.
- GREEN: `pnpm exec vitest run tests/unit/personal-context-usage-validator.test.ts tests/integration/reply-service.test.ts tests/integration/reply-production-policy.test.ts` exited 0 with 3 files and 74 tests passed; `pnpm exec tsc --noEmit` exited 0.
- Full verification at the Task 2 commit: `pnpm test` passed 29 files / 168 tests; `pnpm test:integration` passed 13 files / 143 tests; `git diff --check` exited 0.

### Task 3 — API, persistence, production profile, and migration contracts

- RED: `pnpm exec vitest run tests/integration/replies-route.test.ts tests/integration/production-reply-context.test.ts tests/unit/schema-contract.test.ts tests/integration/private-workflow-security.test.ts` exited 1 with 2 failed / 2 passed files and 3 failed / 39 passed tests (42 total). Required mode was rejected at the API boundary, typed unavailable did not reach 409, and the schema lacked `personalContextMode`.
- GREEN: the same focused command exited 0 with 4 files and 42 tests passed.
- Migration and full verification: `pnpm exec drizzle-kit check --config=drizzle.config.ts` exited 0 with `Everything's fine`; `pnpm exec tsc --noEmit` exited 0; `pnpm test` passed 29 files / 169 tests; `pnpm test:integration` passed 13 files / 149 tests; `git diff --check` exited 0.

### Task 4 — remembered composer control and recovery UI

- RED: `pnpm exec vitest run tests/unit/reply-composer.test.tsx tests/unit/reply-results.test.tsx` exited 1 with 5 intended failures covering the missing checkbox/request mode, typed 409 recovery, and inference warning copy.
- GREEN: the same command exited 0 with 2 files and 15 tests passed.
- Full verification at the Task 4 commit: `pnpm exec tsc --noEmit` and `pnpm build` exited 0; `pnpm test` passed 29 files / 174 tests; `pnpm test:integration` passed 13 files / 149 tests.

## Scope and behavior

Task 5 aligns the non-production browser fixture with the production `GenerateRepliesCommand` and `ReplyGenerationResult` contract. The fixture remains gated by `NODE_ENV !== "production"` and `E2E_FIXTURE_MODE === "1"`. Required mode now calls the shared `selectRequiredPersonalContext` selector, returns the typed unavailable result before storage when no eligible fact exists, generates three deterministic strategy-distinct texts that apply the selected fact meaning without copying its stored statement, resolves public evidence through the shared evidence helpers, and warns every AI-inference-only candidate.

Successful fixture requests persist `personalContextMode` only through `encryptJson`; unavailable requests persist neither a request nor candidates. The route retains empty fixture persistence so successful requests are not written twice. Normal-mode text, clarification, indirectness warnings, and call counts remain unchanged.

Implemented files:

- `src/domain/testing/e2e-fixture-store.ts`: three fixture profile states, shared selection/evidence flow, deterministic reflected candidates, typed unavailable result, and encrypted mode persistence.
- `src/app/api/replies/route.ts`: documents the single-persistence boundary and unavailable early return.
- `tests/unit/e2e-fixture-store.test.ts`: verified, inferred, unavailable, encrypted-storage, and normal-regression coverage.
- `tests/e2e/private-reply-flow.spec.ts`: semantic browser coverage for verified/inferred/unavailable outcomes, remembered mode, recovery navigation, clarification, and copy.
- `docs/acceptance/mvp-checklist.md`: exact Task 5 acceptance evidence.

## RED and GREEN evidence

- Fixture RED: `pnpm exec vitest run tests/unit/e2e-fixture-store.test.ts` exited 1 with 4 intended failures and 1 passing normal-mode regression. Missing behaviors were verified-fact reflection, AI-only warning, unavailable-without-storage, and encrypted mode storage.
- Fixture GREEN: the same command exited 0 with 1 file and 5 tests passed after the shared-selector implementation.
- Browser discovery: `pnpm exec playwright test --list` exited 0 and listed 2 tests, including `covers verified, inferred, unavailable, remembered mode, clarification, and copy flows`.
- Browser runtime iterations exposed and removed stale test assumptions about the login destination, controlled upload hydration, and a single-fact basis. The final semantic locator flow passed in system Chrome.

## Final acceptance verification

| Gate | Result |
| --- | --- |
| Focused feature matrix | Exit 0; 12 files, 143 tests passed. |
| Full unit suite | Exit 0; 29 files, 178 tests passed. |
| Full integration suite | Exit 0; 13 files, 149 tests passed. |
| TypeScript | `pnpm exec tsc --noEmit` exit 0. An earlier run correctly failed on an over-narrow `ProfileFactView[]` helper parameter; the helper now consumes the selector's `ParticipantProfileContext[]`. |
| Drizzle | Exit 0; `Everything's fine`. |
| Production build | Exit 0; Next production compilation, type checking, static generation, and route emission completed. |
| Diff hygiene | `git diff --check` exit 0 with no output. |
| Playwright discovery | Exit 0; 2 tests discovered. |
| Browser runtime | `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' pnpm exec playwright test tests/e2e/private-reply-flow.spec.ts` exit 0; 1/1 passed in 10.1 seconds. |

The exact unconfigured browser command was also attempted. It reached the local server but could not launch because `/Users/gimghoon/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell` was absent. System Chrome was available and provided the successful runtime evidence above; no browser-runtime limitation remains for this task.

## Privacy and scope review

The required scan found 11 expected internal/UI matches. `selectedFacts` is confined to the semantic usage validator input; `profile.value` matches are confined to in-memory context/evidence construction or the intended profile editing/display UI. No rejected/internal value, selected fact ID, semantic explanation, or raw model output leaks through failures, logs, retry rules, or plaintext database columns. Resolved basis summaries for selected facts are intentionally returned to the user and encrypted at rest.

`git status --short` contained only the six scoped Task 5 files before staging. `.env.local` was not read, modified, staged, or otherwise touched during Task 5.
