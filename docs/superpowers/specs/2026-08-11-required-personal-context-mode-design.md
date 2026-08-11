# Required Personal Context Mode Design

## Goal

Add an opt-in reply mode that requires every generated candidate to reflect at least one stored personal-context fact about the selected participant. The fact must influence the reply wording naturally; the reply must not quote the profile record verbatim or tell the recipient that a profile is being used.

Normal reply generation remains unchanged when the mode is off.

## User Experience

The reply composer adds a checkbox labeled `개인 컨텍스트 강제 반영` with helper text explaining that every candidate will use a stored tendency, speech pattern, or response pattern.

The checkbox is off for a first-time browser. Its value is stored locally after the user changes it and restored on later visits. It remains a per-request choice and can always be changed before generation.

When the mode is on, each reply card continues to show `퍼스널 컨텍스트 근거`. At least one displayed basis must correspond to the fact actually reflected in that candidate's wording. Candidates may use the same fact when it is the best fit, or different facts when their strategies call for different evidence.

If only AI-inferred facts are available, generation proceeds and every affected candidate displays `AI가 추정한 개인 컨텍스트를 사용했어요. 실제 성향과 맞는지 확인해 주세요.` If no usable fact exists, the API returns a typed unavailable result and the UI shows `사용할 개인 컨텍스트가 없어요. 프로필을 먼저 확인하거나 직접 추가해 주세요.` with a link to the selected participant's profile.

## Request and Persistence Contract

The reply request accepts `personalContextMode: "normal" | "required"`. Missing values default to `normal` for backward compatibility. The reply composer always sends the effective value.

`reply_requests` stores whether required mode was selected so a saved generation request can be audited. A generated candidate continues to store its resolved context basis and warnings in encrypted columns. No plaintext profile fact, selected fact ID, or validation explanation is added to logs.

The unavailable response uses HTTP 409 and this body:

```json
{
  "kind": "personal_context_unavailable",
  "message": "사용할 개인 컨텍스트가 없어요. 프로필을 먼저 확인하거나 직접 추가해 주세요."
}
```

This response is produced before model or embedding calls and before reply-request persistence.

## Profile Fact Selection

Profile context passed to reply generation retains the fact ID, source, and lock state in addition to kind, value, conditions, and exceptions. Change proposals are never eligible.

Eligible facts are ordered by reliability:

1. `user_edited` facts;
2. `user_confirmed` facts;
3. any other locked, non-proposal fact;
4. `ai_inference` facts.

The first three categories form the trusted set. When that set is nonempty, required mode allows all of those trusted facts, ordered by the reliability list above, and excludes AI inferences. This lets candidates choose different relevant confirmed facts without mixing in speculative facts. Only when the trusted set is empty does the mode allow AI-inferred facts. Within the allowed set, each candidate independently chooses the fact most relevant to its strategy and the current situation.

When tier 4 is selected, the public candidate receives a new `unverified_profile_context` warning. Normal mode may continue using profile context as it does today and does not add this warning merely because AI-inferred context is present.

## Generation and Validation

The structured generation response continues to include `contextBasisIds`. In required mode, structural validation requires every candidate to provide at least one ID from the allowed set. Unknown IDs, empty lists, and AI-inference IDs selected while trusted facts exist fail with the opaque rule ID `REQUIRED_PERSONAL_CONTEXT_MISSING`.

An ID alone does not prove that the wording used the fact. After each structured generation attempt, one batched structured model check evaluates all three candidates against their selected allowed facts. It returns only candidate strategy and a reflected boolean. A candidate passes when its wording semantically reflects the selected tendency, speech pattern, preference, condition, or exception without inventing a new event or directly exposing the stored profile record.

Candidates that fail the semantic check receive the opaque retry rule `PERSONAL_CONTEXT_NOT_REFLECTED`. The existing one-retry generation limit is preserved: the complete ordered tuple is generated at most twice. Each attempt performs at most one batched usage check. Normal mode skips this extra check entirely.

After the second failed attempt, the route returns the existing generic generation error. Rejected text, profile values, semantic-check explanations, and raw model output are never included in retry feedback, logs, or the client response.

Existing contradiction, relationship, safety, specific-fact, and protected-intent validation still applies in both modes. Required personal context never overrides those rules.

## Components and Data Flow

1. `ReplyComposer` restores the browser-local checkbox and sends the effective mode.
2. The reply API validates the mode and verifies room, participant, and analysis readiness as it does today.
3. The production context adapter retains fact identity and provenance, excludes proposals, and selects trusted facts or the AI-inference fallback.
4. With no eligible facts, the service returns the typed unavailable result without provider or database side effects.
5. The generator receives the allowed tier and requires candidate basis IDs.
6. The batched semantic validator checks that each candidate's wording reflects its selected fact.
7. Valid candidates resolve IDs to human-readable basis labels and add the AI-inference warning when applicable.
8. The API persists the request mode plus encrypted candidate basis and warning metadata, then returns exactly three candidates.

Fixture mode follows the same public request/result contract and provides deterministic verified and inferred facts for browser tests.

## Failure Handling

- Missing or invalid mode: HTTP 400 through existing request validation.
- Required mode with no eligible facts: typed HTTP 409, no provider call, no persistence.
- Unknown or empty basis ID, or an AI-inference ID used while trusted facts exist: retry once with `REQUIRED_PERSONAL_CONTEXT_MISSING` only.
- Wording does not reflect selected fact: retry once with `PERSONAL_CONTEXT_NOT_REFLECTED` only.
- Validator/provider failure: existing generic provider or generation failure handling; no private content in logs.
- Normal mode: no new failure path and no added model call.

## Privacy and Safety

Required mode uses profile facts already permitted in the existing model context and does not broaden room or participant scope. Only facts belonging to the selected room participant are eligible. Profile values, selected IDs, and validation payloads remain server-side; user-visible basis text and warnings remain encrypted at rest after persistence.

The generated message must not mention profiling, stored analysis, surveillance, or hidden evidence. Directly exposing a profile statement is treated as not naturally reflected and fails semantic validation.

## Testing and Acceptance

Tests cover:

- default-off behavior and browser-local restoration;
- request validation and backward-compatible normal default;
- persistence of the selected mode;
- exact reliability ordering and proposal exclusion;
- independently selected evidence per strategy;
- reuse of one best fact across multiple candidates;
- typed 409 with zero model, embedding, or persistence calls when no fact exists;
- rejection of empty or unknown basis IDs and AI-inference IDs used while trusted facts exist;
- batched semantic validation and one opaque retry;
- generic failure after the second invalid tuple without private content leakage;
- AI-inference fallback and warning on every affected candidate;
- no extra validator call or new failure path in normal mode;
- retained contradiction, relationship, safety, protected-intent, and exactly-three-candidate behavior;
- encrypted request/candidate persistence and room-participant isolation;
- fixture browser flow for verified facts, inferred fallback, unavailable profile, and remembered toggle state.

Completion requires focused unit and integration tests, the full unit and integration suites, TypeScript checking, Drizzle schema validation and generated migration checks, a production build, and privacy-safe diff/log review.
