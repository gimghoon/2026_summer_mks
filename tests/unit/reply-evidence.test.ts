import {
  NO_PERSONAL_CONTEXT_BASIS,
  buildPersonalContextEvidence,
  resolveContextBasis,
} from "@/domain/replies/reply-evidence";

test("builds bounded summaries without raw conversation quotes", () => {
  const evidence = buildPersonalContextEvidence([{
    id: "fact-tone",
    kind: "tone",
    value: "짧은 문장과 장난스러운 반응을 자주 사용함",
    conditions: ["친한 친구와 대화할 때"],
    exceptions: ["갈등 상황"],
  }]);
  expect(evidence).toEqual([expect.objectContaining({
    id: "fact-tone",
    summary: expect.stringContaining("tone: 짧은 문장"),
  })]);
  expect(evidence[0]!.summary.length).toBeLessThanOrEqual(120);
});

test("resolves only known unique ids and caps the result at two", () => {
  const evidence = buildPersonalContextEvidence([
    { id: "fact-tone", kind: "tone", value: "짧게 답함" },
    { id: "fact-reaction", kind: "reaction", value: "장난스럽게 반응함" },
    { id: "fact-pace", kind: "pace", value: "빠르게 답함" },
  ]);
  expect(resolveContextBasis(["fact-reaction", "invented", "fact-reaction", "fact-tone", "fact-pace"], evidence))
    .toEqual([evidence[1]!.summary, evidence[0]!.summary]);
});

test("returns the fixed fallback when no supplied id is valid", () => {
  expect(resolveContextBasis(["invented"], [])).toEqual([NO_PERSONAL_CONTEXT_BASIS]);
});

test("uses the stored fact ID in personal context evidence", () => {
  expect(buildPersonalContextEvidence([
    { id: "fact-a", kind: "response_pattern", value: "답을 짧게 함" },
  ])).toEqual([{ id: "fact-a", summary: "response_pattern: 답을 짧게 함" }]);
});
