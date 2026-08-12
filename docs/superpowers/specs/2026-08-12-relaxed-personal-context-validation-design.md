# Relaxed personal-context validation design

## Goal

Required personal-context mode must continue to ground every generated reply in a stored participant-profile fact, but a weak semantic-reflection judgment must no longer make the entire reply request fail.

## Scope

This change applies only when `personalContextMode` is `required`. Normal reply generation remains unchanged.

Every generated candidate must still provide at least one valid `contextBasisId` from the eligible stored profile facts. Missing, empty, or unknown basis IDs continue to trigger the existing retry and final validation failure.

## Semantic validation behavior

The existing batched semantic usage validator still evaluates all three candidates once per generation attempt. Its boolean result becomes advisory:

- `true`: return the candidate without a personal-context reflection warning.
- `false`: return the candidate and attach a `personal_context_weakly_reflected` warning.
- Validator request or response failure: return all otherwise valid candidates and attach a `personal_context_reflection_unverified` warning.

A `false` semantic result must not add `PERSONAL_CONTEXT_NOT_REFLECTED`, trigger a regeneration attempt, or cause an HTTP 500 response. This is an intentional fail-open choice for semantic reflection only.

## Rules that remain enforced

This relaxation does not bypass the existing candidate validation pipeline. Valid personal-context basis IDs remain mandatory, and the existing checks for profile/fact contradiction, unsupported specific facts, relationship-forbidden cues, agency or safety violations, unsupported personal style devices, duplicate output, and protected explicit intent remain unchanged.

The semantic validator's previous checks for weak use, ungrounded application, and profile-like disclosure are not separated in this design. Any `false` result from that validator becomes advisory. This is the accepted trade-off of the simple-relaxation approach.

## API, persistence, and UI

The successful API response continues to return exactly three candidates. The new warning identifiers travel through the existing candidate `warnings` field and are stored through the existing encrypted warning persistence path.

The reply results UI maps the identifiers to these Korean notices:

- `personal_context_weakly_reflected`: `개인 컨텍스트가 약하게 반영됐을 수 있어요.`
- `personal_context_reflection_unverified`: `개인 컨텍스트 반영 여부를 확인하지 못했어요.`

No private profile value, rejected candidate text, or semantic-validator payload is added to server logs or client errors.

## Error handling

Structural generation failures, invalid basis IDs, and failures from the existing mandatory validators retain their current behavior. Only semantic personal-context reflection becomes fail-open.

The obsolete runtime path that throws `PERSONAL_CONTEXT_NOT_REFLECTED` is removed. The identifier may be retained temporarily as an internal compatibility type only if removing it would create unrelated migration work; production generation must no longer emit it.

## Verification

Automated tests will prove that:

1. one or more `false` semantic judgments return three candidates without a retry;
2. only the affected candidates receive the weak-reflection warning;
3. a semantic-validator exception returns three candidates with the unverified warning;
4. missing or unknown required context IDs still retry and fail as before;
5. existing mandatory candidate rules still run;
6. normal mode does not invoke semantic personal-context validation;
7. the UI renders both Korean warning messages;
8. warning metadata persists through the existing encrypted storage boundary.
