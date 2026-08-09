import {
  buildStylePolicy,
  supportedPersonalStyleDevices,
} from "@/domain/replies/style-policy";
import evaluationCases from "../fixtures/style-evaluation.json";

test("female-friend policy forbids romantic and jealousy cues", () => {
  const policy = buildStylePolicy({
    relationship: "female_friend",
    indirectness: 4,
    intent: "apology_prompt",
  });

  expect(policy.forbiddenCues).toEqual(expect.arrayContaining([
    "romantic_affection",
    "jealousy",
    "exclusive_possession",
  ]));
});

test.each(["money_refusal", "consent_boundary", "safety_plan", "firm_rejection", "important_promise"])(
  "level five keeps %s explicit",
  (intent) => {
    const policy = buildStylePolicy({ relationship: "girlfriend", indirectness: 5, intent });
    expect(policy.mustRemainExplicit).toBe(true);
  },
);

test("higher levels replace direct emotion with situation, pauses, and emotion clues", () => {
  const direct = buildStylePolicy({ relationship: "girlfriend", indirectness: 1, intent: "everyday" });
  const indirect = buildStylePolicy({ relationship: "girlfriend", indirectness: 5, intent: "everyday" });

  expect(direct.allowedDevices).toContain("direct_emotion");
  expect(direct.allowedDevices).not.toContain("implication");
  expect(indirect.allowedDevices).toEqual(expect.arrayContaining([
    "situation_description",
    "hedged_question",
    "pause",
    "emotion_clue",
  ]));
  expect(indirect.allowedDevices).not.toContain("direct_emotion");
});

test("personal chat devices are enabled only by supporting memory", () => {
  expect(supportedPersonalStyleDevices(["평소 짧게 답하고 문장 부호는 거의 쓰지 않는다"])).toEqual([]);
  expect(supportedPersonalStyleDevices(["이모지와 ㅋㅋ는 쓰지 않는다"])).toEqual([]);
  expect(supportedPersonalStyleDevices(["친한 대화에서는 ㅋㅋ, 이모지 😊, 물결표~와 모음 반복 아아아를 쓴다"])).toEqual([
    "laughter",
    "vowel_repetition",
    "tilde",
    "emoji",
  ]);

  const unsupported = buildStylePolicy({
    relationship: "female_friend",
    indirectness: 3,
    intent: "everyday",
  });
  expect(unsupported.allowedDevices).not.toEqual(expect.arrayContaining(["laughter", "emoji"]));
});

test("evaluation fixture has four synthetic cases in every required category", () => {
  expect(evaluationCases).toHaveLength(24);
  expect([...new Set(evaluationCases.map((item) => item.indirectness))].sort()).toEqual([1, 2, 3, 4, 5]);
  for (const category of [
    "everyday",
    "lateness_or_promise",
    "refusal",
    "reconciliation",
    "attraction",
    "money_or_consent",
  ]) {
    expect(evaluationCases.filter((item) => item.category === category)).toHaveLength(4);
  }
  for (const item of evaluationCases) {
    expect(item).toMatchObject({
      relationshipStyle: expect.stringMatching(/^(female_friend|girlfriend)$/),
      indirectness: expect.any(Number),
      intent: expect.any(String),
      forbiddenCues: expect.any(Array),
      requiredSemanticOutcome: expect.any(String),
    });
    expect(item.syntheticSituation).not.toContain("실제 대화");
  }
});
