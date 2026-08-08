import { mergeProfileFact } from "@/domain/memory/profile-corrections";

test("AI extraction cannot overwrite a locked user edit", () => {
  const merged = mergeProfileFact(
    { value: "장난이 적다", source: "user_edited", locked: true },
    { value: "장난이 많다", source: "ai_inference", confidence: 0.92 },
  );

  expect(merged.fact.value).toBe("장난이 적다");
  expect(merged.proposal?.value).toBe("장난이 많다");
  expect(merged.proposal?.source).toBe("ai_change_proposal");
});

test("an unlocked AI inference can be refreshed by newer analysis", () => {
  const merged = mergeProfileFact(
    { value: "농담을 종종 한다", source: "ai_inference", locked: false, confidence: 0.5 },
    { value: "농담을 자주 한다", source: "ai_inference", confidence: 0.9 },
  );

  expect(merged.fact).toMatchObject({
    value: "농담을 자주 한다",
    source: "ai_inference",
    confidence: 0.9,
    locked: false,
  });
  expect(merged.proposal).toBeUndefined();
});

test("user-confirmed knowledge outranks AI even if legacy lock state is false", () => {
  const merged = mergeProfileFact(
    { value: "친한 사람에게만 반말", source: "user_confirmed", locked: false },
    { value: "모두에게 반말", source: "ai_inference", confidence: 0.99 },
  );

  expect(merged.fact.value).toBe("친한 사람에게만 반말");
  expect(merged.proposal?.value).toBe("모두에게 반말");
});
