import { decryptJson } from "@/domain/crypto/encrypted-json";
import { NO_PERSONAL_CONTEXT_BASIS } from "@/domain/replies/reply-evidence";
import { PERSONAL_CONTEXT_UNAVAILABLE_MESSAGE } from "@/domain/replies/required-personal-context";
import type { GenerateRepliesCommand } from "@/domain/replies/reply-service";
import {
  analyzeFixtureRoom,
  deleteFixtureRoom,
  editFixtureProfileFact,
  fixtureRoomCounts,
  fixtureStoredPayloads,
  generateFixtureReplies,
  getFixtureRoom,
  importFixtureRoom,
} from "@/domain/testing/e2e-fixture-store";

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/private_reply_assistant");
  vi.stubEnv("APP_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
});

afterEach(() => vi.unstubAllEnvs());

function requiredFixture() {
  const imported = importFixtureRoom({
    title: "주말 약속",
    selfName: "나",
    rawText: [
      "주말 약속 카카오톡 대화",
      "2026년 8월 7일 오전 9:01, 민수 : 안녕",
      "2026년 8월 7일 오전 9:02, 서연 : 어디서 볼까?",
      "2026년 8월 7일 오전 9:03, 유나 : 좋아",
    ].join("\n"),
  });
  analyzeFixtureRoom(imported.roomId);
  const participants = getFixtureRoom(imported.roomId)?.participants ?? [];
  const participantId = (name: string) => participants.find((participant) => participant.name === name)?.id;
  const verifiedParticipantId = participantId("민수");
  const inferredParticipantId = participantId("서연");
  const emptyParticipantId = participantId("유나");
  expect(verifiedParticipantId).toBeDefined();
  expect(inferredParticipantId).toBeDefined();
  expect(emptyParticipantId).toBeDefined();
  editFixtureProfileFact({
    participantId: verifiedParticipantId!,
    kind: "personality_tendency",
    value: "진지한 상황에서는 장난을 줄임",
    conditions: ["약속을 어겼을 때"],
    exceptions: [],
  });
  return {
    roomId: imported.roomId,
    verifiedParticipantId: verifiedParticipantId!,
    inferredParticipantId: inferredParticipantId!,
    emptyParticipantId: emptyParticipantId!,
  };
}

function requiredInputFor(roomId: string, participantId: string): GenerateRepliesCommand {
  return {
    roomId,
    participantId,
    pastedConversation: "상대: 답이 늦어서 미안해",
    situation: "차분히 아쉬움을 말하고 싶다",
    intent: "apology_prompt",
    indirectness: 3,
    personalContextMode: "required",
  };
}

test("fixture required mode reflects verified facts in all candidates", () => {
  const fixture = requiredFixture();
  try {
    const result = generateFixtureReplies(requiredInputFor(fixture.roomId, fixture.verifiedParticipantId));
    expect(result.kind).toBe("replies");
    if (result.kind !== "replies") return;
    expect(result.candidates.map((candidate) => candidate.text)).toEqual([
      "부드럽게 말하고 싶어. 다음에는 늦을 것 같으면 미리 알려주면 좋겠어.",
      "기다리는 동안 조금 서운했어. 다음에는 미리 알려주면 좋겠어.",
      "다음부터 늦을 때는 꼭 미리 한마디 해줘.",
    ]);
    expect(new Set(result.candidates.map((candidate) => candidate.text))).toHaveLength(3);
    expect(result.candidates.every((candidate) => (
      !candidate.text.includes("진지한 상황에서는 장난을 줄임")
        && !/[ㅎㅋ~]/u.test(candidate.text)
        && candidate.contextBasis.length > 0
        && !candidate.contextBasis.includes(NO_PERSONAL_CONTEXT_BASIS)
    ))).toBe(true);
  } finally {
    deleteFixtureRoom(fixture.roomId);
  }
});

test("fixture inference fallback warns every candidate", () => {
  const fixture = requiredFixture();
  try {
    const result = generateFixtureReplies(requiredInputFor(fixture.roomId, fixture.inferredParticipantId));
    expect(result.kind).toBe("replies");
    if (result.kind !== "replies") return;
    expect(result.candidates.every((candidate) => (
      !candidate.text.includes("장난이 많고 편하게 대화함")
        && /편하게|장난/u.test(candidate.text)
        && candidate.warnings.includes("unverified_profile_context")
    ))).toBe(true);
  } finally {
    deleteFixtureRoom(fixture.roomId);
  }
});

test("fixture no-fact required mode returns unavailable without storage", () => {
  const fixture = requiredFixture();
  try {
    const before = fixtureRoomCounts(fixture.roomId).replyRequests;
    expect(generateFixtureReplies(requiredInputFor(fixture.roomId, fixture.emptyParticipantId))).toEqual({
      kind: "personal_context_unavailable",
      message: PERSONAL_CONTEXT_UNAVAILABLE_MESSAGE,
    });
    expect(fixtureRoomCounts(fixture.roomId).replyRequests).toBe(before);
  } finally {
    deleteFixtureRoom(fixture.roomId);
  }
});

test("fixture stores successful required mode only in encrypted payloads", () => {
  const fixture = requiredFixture();
  try {
    generateFixtureReplies(requiredInputFor(fixture.roomId, fixture.verifiedParticipantId));
    const encryptedPayloads = fixtureStoredPayloads(fixture.roomId);
    expect(encryptedPayloads).not.toContain("required");
    expect(encryptedPayloads.join("\n")).not.toContain("required");
    expect(encryptedPayloads.map((payload) => decryptJson<unknown>(payload))).toContain("required");
  } finally {
    deleteFixtureRoom(fixture.roomId);
  }
});

test("fixture normal mode preserves candidates, clarification, warnings, and request counts", () => {
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
        personalContextMode: "normal",
      });
      if (result.kind !== "replies") throw new Error("fixture unexpectedly requested clarification");
      return result.candidates;
    };

    const directCandidates = repliesAt(3);
    expect(directCandidates.map((candidate) => candidate.text)).toEqual([
      "다음에는 늦을 것 같으면 살짝만 알려줘 ㅎㅎ",
      "기다리면서 조금 아쉽긴 했어~",
      "다음부터 늦을 때는 미리 한마디 부탁해",
    ]);
    expect(directCandidates.map((candidate) => candidate.warnings)).toEqual([[], [], []]);
    for (const level of [6, 7] as const) {
      const candidates = repliesAt(level);
      expect(candidates.map((candidate) => candidate.warnings)).toEqual([
        ["emotional_inference"],
        ["emotional_inference"],
        ["emotional_inference"],
      ]);
      expect(candidates[2].warnings).not.toContain("important_intent_ambiguity");
    }
    expect(generateFixtureReplies({
      ...requiredInputFor(imported.roomId, participantId),
      situation: "맥락이 부족해",
      personalContextMode: "normal",
    })).toEqual({
      kind: "clarification_required",
      question: "어떤 약속 때문에 서운한지 한 가지만 알려줄래요?",
    });
    expect(fixtureRoomCounts(imported.roomId).replyRequests).toBe(3);
  } finally {
    deleteFixtureRoom(imported.roomId);
  }
});
