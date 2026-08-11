import {
  invalidRequiredBasisIds,
  selectRequiredPersonalContext,
} from "@/domain/replies/required-personal-context";
import type { ParticipantProfileContext } from "@/domain/replies/reply-service";

function fact(overrides: Partial<ParticipantProfileContext> = {}): ParticipantProfileContext {
  return {
    id: "fact-default",
    kind: "speech_pattern",
    value: "짧게 답함",
    source: "ai_inference",
    locked: false,
    ...overrides,
  };
}

test("orders trusted facts and excludes proposals and inference", () => {
  const selection = selectRequiredPersonalContext([
    fact({ id: "inferred", source: "ai_inference", locked: false }),
    fact({ id: "proposal", source: "ai_change_proposal", locked: false }),
    fact({ id: "locked", source: "ai_inference", locked: true }),
    fact({ id: "confirmed", source: "user_confirmed", locked: true }),
    fact({ id: "edited", source: "user_edited", locked: true }),
  ]);

  expect(selection.facts.map(({ id }) => id)).toEqual(["edited", "confirmed", "locked"]);
  expect(selection.inferenceOnly).toBe(false);
});

test("uses AI inference only when no trusted fact exists", () => {
  const selection = selectRequiredPersonalContext([
    fact({ id: "proposal", source: "ai_change_proposal", locked: false }),
    fact({ id: "inferred", source: "ai_inference", locked: false }),
  ]);

  expect(selection).toMatchObject({ inferenceOnly: true });
  expect(selection.facts.map(({ id }) => id)).toEqual(["inferred"]);
});

test("rejects empty and unknown required basis IDs", () => {
  const allowed = new Set(["fact-a", "fact-b"]);

  expect(invalidRequiredBasisIds([], allowed)).toBe(true);
  expect(invalidRequiredBasisIds(["unknown"], allowed)).toBe(true);
  expect(invalidRequiredBasisIds(["fact-a"], allowed)).toBe(false);
});
