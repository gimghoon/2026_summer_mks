# Relaxed personal-context validation implementation report

## Delivered behavior

- Weak semantic reflection returns three candidates with candidate-level warnings.
- Semantic-validator failure returns three candidates with unverified warnings.
- Required basis IDs and all existing mandatory validation remain enforced.

## TDD evidence

- RED: Reproduced in a disposable checkout at `0854830` with only the Task 1/2 test changes applied. The observed commands and failure excerpts follow. The service tests threw errors before reaching matcher assertions, so Vitest emitted no `Expected`/`Received` block.

  `pnpm exec vitest run tests/integration/reply-service.test.ts` — exit 1; 4 failed / 56 passed:

  ```text
  FAIL  tests/integration/reply-service.test.ts > checks all three required candidates in one semantic call and warns weak reflection
  Error: No fake model response queued
   ❯ FakeGateway.extract tests/integration/reply-service.test.ts:23:39
   ❯ ReplyService.generateReplies src/domain/replies/reply-service.ts:551:53
   ❯ tests/integration/reply-service.test.ts:261:18

  FAIL  tests/integration/reply-service.test.ts > warns when a conditional use invents an ungrounded state
  Error: No fake model response queued
   ❯ FakeGateway.extract tests/integration/reply-service.test.ts:23:39
   ❯ ReplyService.generateReplies src/domain/replies/reply-service.ts:551:53
   ❯ tests/integration/reply-service.test.ts:311:18

  FAIL  tests/integration/reply-service.test.ts > returns candidate-aligned warnings without retrying weak semantic reflection
  Error: No fake model response queued
   ❯ FakeGateway.extract tests/integration/reply-service.test.ts:23:39
   ❯ ReplyService.generateReplies src/domain/replies/reply-service.ts:551:53
   ❯ tests/integration/reply-service.test.ts:479:18

  FAIL  tests/integration/reply-service.test.ts > returns unverified warnings when semantic personal-context validation fails
  Error: PRIVATE_VALIDATOR_PAYLOAD
   ❯ Object.<anonymous> tests/integration/reply-service.test.ts:508:25
   ❯ ReplyService.generateReplies src/domain/replies/reply-service.ts:603:51
   ❯ tests/integration/reply-service.test.ts:511:18
  ```

  `pnpm exec vitest run tests/unit/reply-results.test.tsx` — exit 1; 1 failed / 5 passed:

  ```text
  FAIL  tests/unit/reply-results.test.tsx > shows advisory personal-context reflection notices
  TestingLibraryElementError: Unable to find an element with the text: 개인 컨텍스트가 약하게 반영됐을 수 있어요.. This could be because the text is broken up by multiple elements. In this case, you can provide a function for your text matcher to make your matcher more flexible.
   ❯ tests/unit/reply-results.test.tsx:47:17
      47|   expect(screen.getByText(
        |                 ^
      48|     "개인 컨텍스트가 약하게 반영됐을 수 있어요.",
      49|   )).toBeVisible();
  ```
- GREEN: `pnpm exec vitest run tests/integration/reply-service.test.ts tests/unit/reply-results.test.tsx tests/integration/replies-route.test.ts` — 3 test files passed, 82 tests passed (exit 0).

## Final verification

- Focused: 3 test files passed, 82 tests passed (exit 0).
- Unit: 30 test files passed, 180 tests passed (exit 0).
- Integration: 13 test files passed, 154 tests passed (exit 0).
- TypeScript: `pnpm exec tsc --noEmit` exited 0 with no output.
- Production build: `pnpm build` exited 0; Next.js compiled successfully and generated 12 static pages. It warned that it inferred a workspace root because two lockfiles were detected.
- Privacy/scope scans: both `rg` scans returned no matches; `git diff --check` was clean; `git status --short` returned no entries.

## Accepted trade-off

Every semantic false result is advisory by explicit product choice; independent deterministic validation remains active.
