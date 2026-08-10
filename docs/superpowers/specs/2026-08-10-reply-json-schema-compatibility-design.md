# Reply JSON Schema Compatibility Design

## Problem

Reply generation sends a JSON Schema tuple containing three position-specific candidate objects. The OpenAI Responses API rejects that schema with `400 invalid_json_schema`, so the reply route returns `500` before any candidate is generated.

## Design

Replace the provider-facing tuple with an array whose item is one candidate object. The candidate strategy is an enum of `relationship_soft`, `emotion_signal`, and `clearer_request`; the array keeps `minItems: 3` and `maxItems: 3`. This shape is compatible with strict structured outputs.

The application remains responsible for the stronger product contract. After schema decoding, it verifies that the three strategies appear exactly once and in the required order. A wrong order or duplicate strategy is treated as `OUTPUT_STRUCTURE`, uses the existing single retry, and never reaches persistence.

No prompt content, style policy, retrieval logic, database schema, or API response shape changes.

## Error Handling

- Provider schema rejection continues to surface through the existing generic reply failure boundary without exposing private input.
- Structurally valid JSON with the wrong strategy order receives one opaque `OUTPUT_STRUCTURE` retry.
- A second invalid result raises the existing `ReplyGenerationValidationError`.

## Verification

- Add a regression proving the generated provider schema uses a homogeneous `items` object instead of tuple-style item arrays.
- Add service regressions proving wrong strategy order is retried and then rejected if repeated.
- Run the focused model gateway and reply service suites, TypeScript, and the full unit/integration suites.
