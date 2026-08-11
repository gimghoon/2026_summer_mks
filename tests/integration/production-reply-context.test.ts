import type { ModelGateway, StructuredModelRequest } from "@/domain/models/gateway";
import {
  buildProductionReplyContext,
  parsePastedConversationTurns,
  type ProductionContextSnapshot,
} from "@/domain/replies/production-context";
import { generateReplies, type GenerateRepliesCommand } from "@/domain/replies/reply-service";
import { PERSONAL_CONTEXT_UNAVAILABLE_MESSAGE, selectRequiredPersonalContext } from "@/domain/replies/required-personal-context";

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
  personalContextMode: "normal",
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
        { strategy: "relationship_soft", text: "다음에는 미리 알려주면 좋겠어", intentLabel: "관계 유지", riskLabel: null, contextBasisIds: [] },
        { strategy: "emotion_signal", text: "기다리면서 조금 아쉽긴 했어", intentLabel: "감정 전달", riskLabel: null, contextBasisIds: [] },
        { strategy: "clearer_request", text: "다음부터는 늦을 때 알려줘", intentLabel: "요청", riskLabel: null, contextBasisIds: [] },
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
  participantProfiles: [{
    id: "fact-nickname",
    kind: "nickname",
    value: "곰돌이",
    source: "user_confirmed",
    locked: true,
  }],
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

test("preserves profile identity and provenance in the production reply context", async () => {
  const context = await buildProductionReplyContext(command, "female_friend", new RecordingGateway(), snapshot);

  expect(context.participantProfiles).toEqual([{
    id: "fact-nickname",
    kind: "nickname",
    value: "곰돌이",
    source: "user_confirmed",
    locked: true,
  }]);
  expect(context.currentFacts).toBeUndefined();
});

test("required selection excludes profile change proposals", () => {
  const selection = selectRequiredPersonalContext([{
    id: "proposal-fact",
    kind: "nickname",
    value: "제안된 별명",
    source: "ai_change_proposal",
    locked: false,
  }]);

  expect(selection.facts).toEqual([]);
});

test("required profile preflight returns before embedding while normal mode skips it", async () => {
  const gateway = new RecordingGateway();
  const loadParticipantProfiles = vi.fn(async () => []);
  const load = vi.fn(async () => buildProductionReplyContext(command, "female_friend", gateway, snapshot));

  const result = await generateReplies({ ...command, personalContextMode: "required" }, {
    gateway,
    contextProvider: { loadParticipantProfiles, load },
    factValidator: async () => true,
    personalContextUsageValidator: async () => ({
      relationship_soft: true,
      emotion_signal: true,
      clearer_request: true,
    }),
  });

  expect(result).toEqual({ kind: "personal_context_unavailable", message: PERSONAL_CONTEXT_UNAVAILABLE_MESSAGE });
  expect(load).not.toHaveBeenCalled();
  expect(gateway.embeddingInputs).toEqual([]);

  await generateReplies(command, {
    gateway,
    contextProvider: { loadParticipantProfiles, load },
    factValidator: async () => true,
    personalContextUsageValidator: async () => ({
      relationship_soft: true,
      emotion_signal: true,
      clearer_request: true,
    }),
  });
  expect(loadParticipantProfiles).toHaveBeenCalledTimes(1);
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
    contextProvider: {
      loadParticipantProfiles: async () => context.participantProfiles,
      load: async () => context,
    },
    factValidator: async () => true,
    personalContextUsageValidator: async () => ({
      relationship_soft: true,
      emotion_signal: true,
      clearer_request: true,
    }),
  });
  expect(gateway.requests[0]!.input).not.toContain("OLDEST_PRIVATE_SENTINEL");
  expect(gateway.requests[0]!.input).toContain("곰돌이 영화 약속은 다음에 미리 알려줘");
});

test("uses an explicit room participant name to resolve a recent person reference", async () => {
  const explicitCommand: GenerateRepliesCommand = {
    ...command,
    pastedConversation: "민수: 걔는 아직 돈 안 보냈어\n나: 이따 예약해야 해",
    situation: "서연만 아직 돈을 안 보낸 상태다",
    intent: "예약 전에 돈을 보내 달라고 말한다",
  };

  const context = await buildProductionReplyContext(
    explicitCommand,
    "female_friend",
    new RecordingGateway(),
    snapshot,
  );

  expect(context.currentContext.needsUserQuestion).toBe(false);
});

test.each([
  "서연에 대한 이야기를 하고 있다",
  "서연에서 받은 답을 기다리고 있다",
  "서연으로 대상을 정했다",
  "민수로 대상을 정했다",
])("resolves a recent person reference with a bounded name form: %s", async (situation) => {
  const boundedCommand: GenerateRepliesCommand = {
    ...command,
    pastedConversation: "민수: 걔는 아직 돈 안 보냈어\n나: 이따 예약해야 해",
    situation,
    intent: "예약 전에 돈을 보내 달라고 말한다",
  };

  const context = await buildProductionReplyContext(
    boundedCommand,
    "female_friend",
    new RecordingGateway(),
    snapshot,
  );

  expect(context.currentContext.needsUserQuestion).toBe(false);
});

test("does not resolve a recent person reference with a name outside the room", async () => {
  const unknownNameCommand: GenerateRepliesCommand = {
    ...command,
    pastedConversation: "민수: 걔는 아직 돈 안 보냈어\n나: 이따 예약해야 해",
    situation: "걔는 영희를 뜻하고, 영희만 아직 돈을 안 보낸 상태다",
    intent: "영희에게 예약 전에 돈을 보내 달라고 말한다",
  };

  const context = await buildProductionReplyContext(
    unknownNameCommand,
    "female_friend",
    new RecordingGateway(),
    snapshot,
  );

  expect(context.currentContext.needsUserQuestion).toBe(true);
});

test("does not resolve a person reference from an unrelated Korean counter word", async () => {
  const counterCommand: GenerateRepliesCommand = {
    ...command,
    pastedConversation: "민수: 걔는 아직 돈 안 보냈어\n나: 이따 예약해야 해",
    situation: "할 일이 하나만 남았다",
    intent: "예약 전에 돈을 보내 달라고 말한다",
  };
  const counterSnapshot: ProductionContextSnapshot = {
    ...snapshot,
    roomParticipants: [
      ...snapshot.roomParticipants,
      { id: "person-hana", name: "하나", isSelf: false },
    ],
  };

  const context = await buildProductionReplyContext(
    counterCommand,
    "female_friend",
    new RecordingGateway(),
    counterSnapshot,
  );

  expect(context.currentContext.needsUserQuestion).toBe(true);
});
