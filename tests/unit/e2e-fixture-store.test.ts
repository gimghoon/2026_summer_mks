import {
  deleteFixtureRoom,
  generateFixtureReplies,
  getFixtureRoom,
  importFixtureRoom,
} from "@/domain/testing/e2e-fixture-store";

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/private_reply_assistant");
  vi.stubEnv("APP_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
});

afterEach(() => vi.unstubAllEnvs());

test("fixture reply warnings match the creative indirectness policy", () => {
  const imported = importFixtureRoom({
    title: "민수와 대화",
    selfName: "나",
    rawText: "민수와 카카오톡 대화\n2026년 8월 7일 오전 9:01, 민수 : 안녕",
  });
  const participantId = getFixtureRoom(imported.roomId)?.participants.find((participant) => !participant.isSelf)?.id;
  if (!participantId) throw new Error("fixture participant missing");

  try {
    const repliesAt = (indirectness: 3 | 6 | 7) => {
      const result = generateFixtureReplies({
        roomId: imported.roomId,
        participantId,
        pastedConversation: "상대: 답이 늦어서 미안해",
        situation: "차분히 아쉬움을 말하고 싶다",
        intent: "apology_prompt",
        indirectness,
      });
      if (result.kind !== "replies") throw new Error("fixture unexpectedly requested clarification");
      return result.candidates;
    };

    expect(repliesAt(3).map((candidate) => candidate.warnings)).toEqual([[], [], []]);
    for (const level of [6, 7] as const) {
      const candidates = repliesAt(level);
      expect(candidates.map((candidate) => candidate.warnings)).toEqual([
        ["emotional_inference"],
        ["emotional_inference"],
        ["emotional_inference"],
      ]);
      expect(candidates[2].warnings).not.toContain("important_intent_ambiguity");
    }
  } finally {
    deleteFixtureRoom(imported.roomId);
  }
});
