import { protectedIntentKind } from "@/domain/replies/protected-intent";

test("does not treat a completed payment praise as a protected money decision", () => {
  expect(protectedIntentKind("민서가 돈 보낸 거를 토대로 칭찬 아닌 칭찬을 하고 싶어")).toBeNull();
});

test.each([
  "입금해 줘서 고마워, 정말 잘했어",
  "돈 보내줘서 고마워",
])("does not treat completed-payment praise as a protected money request: %s", (intent) => {
  expect(protectedIntentKind(intent)).toBeNull();
});

test.each([
  "돈을 보내 달라고 요청하고 싶어",
  "오늘 중으로 입금해 줘",
  "돈 좀 보내줘",
  "이번 송금을 수락하고 싶어",
  "내일 갚겠다고 말하고 싶어",
  "이번에는 내가 결제할게",
  "돈은 내가 받을게",
  "이번 송금은 거절하고 싶어",
  "금액을 확인하고 입금하겠다고 말하고 싶어",
  "공동 비용은 걷고 개인 쇼핑은 각자 내자고 말하고 싶어",
])("recognizes a real protected money decision: %s", (intent) => {
  expect(protectedIntentKind(intent)).toBe("money");
});

test.each([
  ["consent_boundary", "consent"],
  ["safety_plan", "safety"],
  ["firm_refusal", "refusal"],
  ["important_promise_change", "promise"],
] as const)("preserves the existing protected intent category for %s", (intent, expected) => {
  expect(protectedIntentKind(intent)).toBe(expected);
});
