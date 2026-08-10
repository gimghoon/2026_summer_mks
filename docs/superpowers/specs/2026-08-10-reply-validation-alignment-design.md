# Reply Validation Alignment Design

## Problem

Reply generation succeeds at the provider but exhausts its single validation retry with `EXPLICIT_INTENT_AMBIGUOUS` and `UNSUPPORTED_PERSONAL_DEVICE`.

The submitted money intent describes an allocation boundary: shared activities are collected together while personal shopping is paid individually. The current deterministic validator recognizes only money refusal, request, or acceptance, so it rejects a faithful allocation reply. Separately, the prompt exposes internal allowed-device keys without directly explaining that `ㅋㅋ`, `ㅎㅎ`, repeated vowels, `~`, and emoji are forbidden unless memory supports them.

## Design

Add a bounded money-allocation decision subtype. It activates only when the intent contains both a shared-expense concept and a personal-expense concept. Every returned candidate must preserve both sides: a shared/group expense is collected or settled together, and personal expenses are paid separately by each person. Existing refusal, request, and acceptance behavior remains unchanged.

Make the provider instruction explicit about personal style devices. Map each device key to its visible Korean chat form and state that it may appear only when the corresponding key is present in `policy.allowedDevices`. Keep the deterministic validator and the existing one-retry limit unchanged.

Keep the newly added safe diagnostic category in server logs. It records only the error class and opaque rule IDs; it never records prompts, conversations, profile facts, or generated candidates.

## Error Handling

- A faithful allocation boundary passes deterministic intent validation.
- An allocation reply that omits either the shared-expense rule or the personal-expense rule retries with `EXPLICIT_INTENT_AMBIGUOUS` and then fails closed.
- An unsupported personal style device retries with `UNSUPPORTED_PERSONAL_DEVICE` and then fails closed.
- API errors remain generic to the browser.

## Verification

- Add RED/GREEN service tests for a faithful money-allocation reply and a reply missing one side of the allocation boundary.
- Assert that the model instruction spells out the device-key mapping and conditional prohibition.
- Keep the route regression proving validation logs contain only opaque rule IDs.
- Run focused reply tests, TypeScript, all unit and integration tests, and the production build.
