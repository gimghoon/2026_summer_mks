import type { ModelGateway, StructuredModelRequest } from "@/domain/models/gateway";
import {
  buildProductionReplyContext,
  parsePastedConversationTurns,
  type ProductionContextSnapshot,
} from "@/domain/replies/production-context";
import { generateReplies, type GenerateRepliesCommand } from "@/domain/replies/reply-service";

const command: GenerateRepliesCommand = {
  roomId: "room-a",
  participantId: "person-minsu",
  pastedConversation: [
    "민수: OLDEST_PRIVATE_SENTINEL 이전 얘기",
    ...Array.from({ length: 98 }, (_, index) => `${index % 2 ? "나" : "민수"}: 중간 대화 ${index}`),
    "민수: 곰돌이 영화 약속은 다음에 미리 알려줘",
  ].join("\n"),
  situation: "약속 답장이 늦어서 차분하게 말하고 싶다",
  intent: "다음에는 미리 알려 달라고 요청한다",
  indirectness: 3,
};

class RecordingGateway implements ModelGateway {
  embeddingInputs: string[][] = [];
  requests: StructuredModelRequest<unknown>[] = [];

  async embed(texts: string[]) {
    this.embeddingInputs.push(texts);
    return texts.map(() => [1, 0]);
  }

  async extract<T>(request: StructuredModelRequest<T>): Promise<T> {
    this.requests.push(request as StructuredModelRequest<unknown>);
    return request.schema.parse({
      candidates: [
        { strategy: "relationship_soft", text: "다음에는 미리 알려주면 좋겠어", intentLabel: "관계 유지", riskLabel: null },
        { strategy: "emotion_signal", text: "기다리면서 조금 아쉽긴 했어", intentLabel: "감정 전달", riskLabel: null },
        { strategy: "clearer_request", text: "다음부터는 늦을 때 알려줘", intentLabel: "요청", riskLabel: null },
      ],
    });
  }
}

function storedTurn(id: string, speakerId: string, text: string) {
  return {
    id,
    speakerId,
    startedAt: new Date("2026-08-07T00:00:00.000Z"),
    messages: [{ kind: "text" as const, text }],
  };
}

const snapshot: ProductionContextSnapshot = {
  roomParticipants: [
    { id: "person-self", name: "지훈", isSelf: true },
    { id: "person-minsu", name: "민수", isSelf: false },
    { id: "person-seoyeon", name: "서연", isSelf: false },
  ],
  roomMemory: "친구들과 약속을 자주 잡는 방",
  participantProfiles: [{ kind: "nickname", value: "곰돌이" }],
  chunks: [
    {
      chunkId: "target-history",
      roomId: "room-a",
      startedAt: new Date("2026-08-01T00:00:00.000Z"),
      endedAt: new Date("2026-08-01T00:01:00.000Z"),
      embedding: [1, 0],
      summary: "민수와 곰돌이 영화 약속을 조율함",
      emotions: ["아쉬움"],
      relationshipSignals: ["친근함"],
      topicTags: ["영화"],
      eventTypes: ["약속"],
      turns: [storedTurn("target-turn", "person-minsu", "영화 시간 정하자")],
    },
    {
      chunkId: "wrong-person-history",
      roomId: "room-a",
      startedAt: new Date("2026-08-02T00:00:00.000Z"),
      endedAt: new Date("2026-08-02T00:01:00.000Z"),
      embedding: [1, 0],
      summary: "서연과 영화 약속",
      emotions: [],
      relationshipSignals: [],
      topicTags: ["영화"],
      eventTypes: ["약속"],
      turns: [storedTurn("wrong-turn", "person-seoyeon", "영화 보자")],
    },
  ],
};

test("parses pasted speaker lines into adjacent turns", () => {
  const turns = parsePastedConversationTurns(
    "민수: 첫 문장\n민수: 둘째 문장\n나: 답장",
    snapshot.roomParticipants,
    command.participantId,
    new Date("2026-08-08T00:00:00.000Z"),
  );
  expect(turns.map((turn) => [turn.speakerId, turn.messages.length])).toEqual([
    ["person-minsu", 2],
    ["person-self", 1],
  ]);
});

test("production wiring selects 20 turns, minimizes provider plaintext, and enforces the group participant", async () => {
  const gateway = new RecordingGateway();
  const context = await buildProductionReplyContext(command, "female_friend", gateway, snapshot);

  expect(context.currentContext.usedTurnLimit).toBe(20);
  expect(context.currentContext.turns).toHaveLength(20);
  expect(gateway.embeddingInputs[0]!.join("\n")).not.toContain("OLDEST_PRIVATE_SENTINEL");
  expect(context.retrievedChunks.map((chunk) => chunk.chunkId)).toEqual(["target-history"]);
  expect(context.retrievedChunks[0]!.turns[0]!.messages[0]!.text).toBe("영화 시간 정하자");

  await generateReplies(command, {
    gateway,
    contextProvider: { load: async () => context },
    factValidator: async () => true,
  });
  expect(gateway.requests[0]!.input).not.toContain("OLDEST_PRIVATE_SENTINEL");
  expect(gateway.requests[0]!.input).toContain("곰돌이 영화 약속은 다음에 미리 알려줘");
});
