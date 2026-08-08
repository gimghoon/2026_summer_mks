import { selectCurrentContext } from "@/domain/replies/context-expander";
import {
  createSubmittedContextJudge,
  submittedCurrentTurn,
  validatesReplyFact,
} from "@/domain/replies/reply-production-policy";
import type { ModelGateway, StructuredModelRequest } from "@/domain/models/gateway";
import {
  generateReplies,
  type GenerateRepliesCommand,
  type ReplyGenerationContext,
} from "@/domain/replies/reply-service";

const command: GenerateRepliesCommand = {
  roomId: "room-1",
  participantId: "participant-1",
  pastedConversation: "상대가 오늘 답장이 늦어서 미안하다고 했어. 나는 서운했지만 차분하게 다음에는 미리 알려달라고 말하고 싶어.",
  situation: "답장이 늦어 서운했지만 관계를 해치지 않게 대화하고 싶다",
  intent: "다음에는 늦을 때 미리 알려 달라고 요청한다",
  indirectness: 3,
};

const baseContext: ReplyGenerationContext = {
  relationship: "female_friend",
  currentContext: { turns: [], usedTurnLimit: "full_chunk", needsUserQuestion: false },
  retrievedChunks: [],
  roomMemory: null,
  participantProfiles: [{ kind: "preference", value: "민지는 커피를 좋아해" }],
  currentFacts: ["민지는 커피를 좋아해"],
};

class FakeGateway implements ModelGateway {
  readonly requests: StructuredModelRequest<unknown>[] = [];

  constructor(private readonly responses: unknown[]) {}

  async extract<T>(request: StructuredModelRequest<T>): Promise<T> {
    this.requests.push(request as StructuredModelRequest<unknown>);
    return request.schema.parse(this.responses.shift());
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [1]);
  }
}

function replySet(first: string) {
  return {
    candidates: [
      { strategy: "relationship_soft", text: first, intentLabel: "관계 유지", riskLabel: null },
      { strategy: "emotion_signal", text: "기다리면서 조금 아쉬웠어", intentLabel: "감정 전달", riskLabel: null },
      { strategy: "clearer_request", text: "다음에는 알려줘", intentLabel: "요청", riskLabel: null },
    ],
  };
}

test("production policy accepts complete submitted context when a room has no stored turns", async () => {
  const submitted = submittedCurrentTurn(command);
  const selected = await selectCurrentContext({
    turns: [submitted],
    fullChunkStart: 0,
    judge: createSubmittedContextJudge(command),
  });

  expect(selected.needsUserQuestion).toBe(false);
  expect(selected.turns).toEqual([submitted]);
});

test("production policy still clarifies genuinely sparse submitted context", async () => {
  const sparse = { ...command, pastedConversation: "응", situation: "답장", intent: "확인" };
  const selected = await selectCurrentContext({
    turns: [submittedCurrentTurn(sparse)],
    fullChunkStart: 0,
    judge: createSubmittedContextJudge(sparse),
  });

  expect(selected.needsUserQuestion).toBe(true);
});

test("production fact validator rejects a reply that contradicts a reviewed profile fact", () => {
  expect(validatesReplyFact(
    { strategy: "relationship_soft", text: "민지는 커피를 싫어해", intentLabel: "사실 확인", riskLabel: null },
    baseContext,
  )).toBe(false);
  expect(validatesReplyFact(
    { strategy: "relationship_soft", text: "민지는 커피를 좋아하니까 카페에서 보자", intentLabel: "제안", riskLabel: null },
    baseContext,
  )).toBe(true);
});

test("production fact validator accepts a context-grounded reply when raw conversation is not a reviewed fact", () => {
  const context: ReplyGenerationContext = {
    ...baseContext,
    participantProfiles: [],
    currentFacts: [],
    currentContext: {
      turns: [{
        id: "turn-1",
        speakerId: "participant-1",
        startedAt: new Date("2026-08-08T00:00:00.000Z"),
        messages: [{ kind: "text", text: "오늘 시간 있어?" }],
      }],
      usedTurnLimit: "full_chunk",
      needsUserQuestion: false,
    },
  };

  expect(validatesReplyFact(
    { strategy: "relationship_soft", text: "오늘은 시간이 없어", intentLabel: "일정 전달", riskLabel: null },
    context,
  )).toBe(true);
});

test.each([
  ["좋아함", "민지는 커피를 좋아해", "민지는 커피를 싫어해"],
  ["안 좋아함", "민지는 커피를 좋아해", "민지는 커피를 안 좋아해"],
  ["좋아하지 않음", "민지는 커피를 좋아해", "민지는 커피를 좋아하지 않아"],
  ["있음", "민지는 오늘 시간이 있어", "민지는 오늘 시간이 없어"],
  ["가능", "민지는 지금 가능해", "민지는 지금 불가능해"],
  ["원함", "민지는 여행을 원해", "민지는 여행을 원하지 않아"],
  ["좋아하지 않음-to-좋아함", "민지는 커피를 안 좋아해", "민지는 커피를 좋아해"],
  ["없음-to-있음", "민지는 오늘 시간이 없어", "민지는 오늘 시간이 있어"],
  ["불가능-to-가능", "민지는 지금 불가능해", "민지는 지금 가능해"],
  ["원하지 않음-to-원함", "민지는 여행을 원하지 않아", "민지는 여행을 원해"],
])("production fact validator rejects %s polarity conflicts", (_label, reviewedFact, candidateText) => {
  const context: ReplyGenerationContext = {
    ...baseContext,
    participantProfiles: [{ kind: "reviewed_fact", value: reviewedFact }],
    currentFacts: [reviewedFact],
  };

  expect(validatesReplyFact(
    { strategy: "relationship_soft", text: candidateText, intentLabel: "사실 확인", riskLabel: null },
    context,
  )).toBe(false);
});

test("production fact validator retries contradictions with an opaque rule ID", async () => {
  const gateway = new FakeGateway([
    replySet("민지는 커피를 싫어해"),
    replySet("민지는 커피를 좋아하니까 카페에서 보자"),
  ]);

  await expect(generateReplies(command, {
    gateway,
    contextProvider: { load: async () => baseContext },
    factValidator: validatesReplyFact,
  })).resolves.toMatchObject({ kind: "replies" });

  const retryInput = gateway.requests[1]!.input;
  expect(JSON.parse(retryInput).validationRuleIds).toEqual(["FACT_CONTRADICTION"]);
  expect(retryInput).not.toContain("민지는 커피를 싫어해");
});
