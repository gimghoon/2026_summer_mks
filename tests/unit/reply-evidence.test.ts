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
