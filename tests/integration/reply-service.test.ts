import { z } from "zod";

import type { StructuredModelRequest, ModelGateway } from "@/domain/models/gateway";
import {
  generateReplies,
  ReplyGenerationValidationError,
  type GenerateRepliesCommand,
  type ReplyCandidateContent,
  type ReplyGenerationContext,
} from "@/domain/replies/reply-service";

class FakeGateway implements ModelGateway {
  readonly requests: StructuredModelRequest<unknown>[] = [];

  constructor(private readonly responses: unknown[]) {}

  async extract<T>(request: StructuredModelRequest<T>): Promise<T> {
    this.requests.push(request as StructuredModelRequest<unknown>);
    const response = this.responses.shift();
    if (response === undefined) throw new Error("No fake model response queued");
    if (response instanceof Error) throw response;
    return request.schema.parse(response);
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [1]);
  }
}

const command: GenerateRepliesCommand = {
  roomId: "room-1",
  participantId: "participant-1",
  pastedConversation: "상대: 오늘 답이 늦어서 미안해\n나: 괜찮아",
  situation: "답이 늦어서 조금 서운하지만 차분하게 말하고 싶다",
  intent: "apology_prompt",
  indirectness: 4,
};

const context: ReplyGenerationContext = {
  relationship: "female_friend",
  currentContext: {
    turns: [{
      id: "turn-1",
      speakerId: "participant-1",
      startedAt: new Date("2026-08-08T00:00:00.000Z"),
      messages: [{ kind: "text", text: "오늘 답이 늦어서 미안해" }],
    }],
    usedTurnLimit: 20,
    needsUserQuestion: false,
  },
  retrievedChunks: [{
    chunkId: "chunk-1",
    score: 0.8,
    summary: "답이 늦었을 때 차분하게 이야기했다",
    turns: [],
  }],
  roomMemory: "친한 대화에서는 ㅋㅋ와 이모지를 가끔 쓴다",
  participantProfiles: [{ kind: "speech_pattern", value: "짧고 부드럽게 말한다" }],
  currentFacts: ["상대의 답이 오늘 늦었다"],
};

function candidates(
  texts: [string, string, string],
  contextBasisIds: [string[], string[], string[]] = [[], [], []],
) {
  return {
    candidates: [
      { strategy: "relationship_soft", text: texts[0], intentLabel: "관계 유지", riskLabel: null, contextBasisIds: contextBasisIds[0] },
      { strategy: "emotion_signal", text: texts[1], intentLabel: "서운함 신호", riskLabel: "너무 돌려 들릴 수 있음", contextBasisIds: contextBasisIds[1] },
      { strategy: "clearer_request", text: texts[2], intentLabel: "다음 행동 요청", riskLabel: null, contextBasisIds: contextBasisIds[2] },
    ],
  };
}

function dependencies(gateway: ModelGateway, extra: Partial<Parameters<typeof generateReplies>[1]> = {}) {
  return {
    gateway,
    contextProvider: { load: vi.fn(async () => context) },
    factValidator: vi.fn(() => true),
    ...extra,
  };
}

const invalidAdvisoryResponse = candidates([
  "사랑해 자기야, 무조건 보내, 오후 7시에~",
  "공동 비용은 걷고 개인 쇼핑은 각자 내자",
  "공동 비용은 걷고 개인 쇼핑은 각자 내자",
]);

const protectedAllocationCommand: GenerateRepliesCommand = {
  ...command,
  intent: "공동 비용은 걷고 개인 쇼핑은 각자 내자고 말하고 싶어",
};

test("returns exactly three candidates in the required strategy order", async () => {
  const gateway = new FakeGateway([candidates([
    "바빴구나, 다음엔 한마디만 해주면 좋을 것 같아",
    "괜찮긴 한데 기다리면서 살짝 신경 쓰이긴 했어",
    "다음부터 늦을 것 같으면 미리 알려줘",
  ])]);

  const result = await generateReplies(command, dependencies(gateway));

  expect(result.kind).toBe("replies");
  if (result.kind !== "replies") return;
  expect(result.candidates).toHaveLength(3);
  expect(result.candidates.map((candidate) => candidate.strategy)).toEqual([
    "relationship_soft",
    "emotion_signal",
    "clearer_request",
  ]);
  expect(gateway.requests[0]).toMatchObject({ purpose: "reply", schemaName: "woman_speech_reply_candidates" });
  expect(gateway.requests[0]!.system).toContain("female_friend");
  expect(gateway.requests[0]!.system).toContain("laughter");
  expect(gateway.requests[0]!.system).toContain("emoji");
  expect(gateway.requests[0]!.system).toContain("laughter=ㅋㅋ/ㅎㅎ");
  expect(gateway.requests[0]!.system).toContain("tilde=~");
  expect(gateway.requests[0]!.system).toContain("emoji=emoji");
  expect(gateway.requests[0]!.system).toContain("only if its key is listed in Policy.allowedDevices");
});

test("exposes verified profile evidence for known IDs and a fixed fallback for unknown IDs", async () => {
  const gateway = new FakeGateway([candidates([
    "바빴구나, 다음엔 한마디만 해주면 좋을 것 같아",
    "괜찮긴 한데 기다리면서 살짝 신경 쓰이긴 했어",
    "다음부터 늦을 것 같으면 미리 알려줘",
  ], [["profile-0"], ["invented"], []])]);

  const result = await generateReplies(command, dependencies(gateway));

  expect(result.kind).toBe("replies");
  if (result.kind !== "replies") return;
  expect(result.candidates[0]).toMatchObject({
    contextBasis: ["speech_pattern: 짧고 부드럽게 말한다"],
    warnings: [],
  });
  expect(result.candidates[1]).toMatchObject({
    contextBasis: ["현재 상황과 답장 의도만 사용"],
    warnings: [],
  });
  expect(JSON.parse(gateway.requests[0]!.input).personalContextEvidence).toEqual([
    { id: "profile-0", summary: "speech_pattern: 짧고 부드럽게 말한다" },
  ]);
});

test("level seven requests three context-grounded creative circumlocution strategies", async () => {
  const gateway = new FakeGateway([candidates([
    "오늘도 시계는 나만 보고 있었나 봐",
    "기다리는 쪽은 시간이 더 천천히 가나 보네",
    "다음 시계는 같이 보면 좋겠다",
  ])]);

  await generateReplies({ ...command, indirectness: 7 }, dependencies(gateway));

  const system = gateway.requests[0]!.system;
  expect(system).toContain("level 7");
  expect(system).toContain("contextual metaphor");
  expect(system).toContain("playful implication");
  expect(system).toContain("quiet aftertaste");
  expect(system).toContain("supplied conversation");
  expect(system).toContain("keep the actual decision unambiguous at every indirectness level");
});

test.each([6, 7] as const)(
  "level %s returns candidate-aligned warnings without retrying content violations",
  async (indirectness) => {
    const gateway = new FakeGateway([invalidAdvisoryResponse]);
    const factValidator = vi.fn((candidate: ReplyCandidateContent) => !candidate.text.includes("오후 7시"));

    const result = await generateReplies(
      { ...protectedAllocationCommand, indirectness },
      dependencies(gateway, { factValidator }),
    );

    expect(result).toMatchObject({ kind: "replies" });
    if (result.kind !== "replies") return;
    expect(gateway.requests).toHaveLength(1);
    expect(result.candidates[0]!.warnings).toEqual([
      "emotional_inference",
      "relationship_boundary",
      "agency_or_safety",
      "personal_style_mismatch",
      "specific_fact_inference",
      "profile_conflict",
      "important_intent_ambiguity",
    ]);
    expect(result.candidates[1]!.warnings).toEqual(["emotional_inference", "duplicate_text"]);
    expect(result.candidates[2]!.warnings).toEqual(["emotional_inference", "duplicate_text"]);
    expect(result.candidates.flatMap((candidate) => candidate.warnings)).toEqual(expect.arrayContaining([
      "personal_style_mismatch",
      "important_intent_ambiguity",
    ]));
  },
);

test("level five retries once and rejects the same content violations with opaque rule IDs", async () => {
  const gateway = new FakeGateway([invalidAdvisoryResponse, invalidAdvisoryResponse]);
  const factValidator = vi.fn((candidate: ReplyCandidateContent) => !candidate.text.includes("오후 7시"));

  await expect(generateReplies(
    { ...protectedAllocationCommand, indirectness: 5 },
    dependencies(gateway, { factValidator }),
  )).rejects.toMatchObject({
    ruleIds: [
      "DUPLICATE_TEXT",
      "RELATIONSHIP_FORBIDDEN_CUE",
      "AGENCY_OR_SAFETY_VIOLATION",
      "UNSUPPORTED_PERSONAL_DEVICE",
      "UNSUPPORTED_SPECIFIC_FACT",
      "FACT_CONTRADICTION",
      "EXPLICIT_INTENT_AMBIGUOUS",
    ],
  });
  expect(gateway.requests).toHaveLength(2);
  expect(JSON.parse(gateway.requests[1]!.input).validationRuleIds).toEqual([
    "DUPLICATE_TEXT",
    "RELATIONSHIP_FORBIDDEN_CUE",
    "AGENCY_OR_SAFETY_VIOLATION",
    "UNSUPPORTED_PERSONAL_DEVICE",
    "UNSUPPORTED_SPECIFIC_FACT",
    "FACT_CONTRADICTION",
    "EXPLICIT_INTENT_AMBIGUOUS",
  ]);
});

test("uses an OpenAI-compatible homogeneous array schema for three candidates", async () => {
  const gateway = new FakeGateway([candidates([
    "바빴구나, 다음엔 말해줘",
    "기다리면서 조금 아쉬웠어",
    "늦을 때는 미리 알려줘",
  ])]);

  await generateReplies(command, dependencies(gateway));

  const jsonSchema = z.toJSONSchema(gateway.requests[0]!.schema, { target: "draft-7" }) as {
    properties?: {
      candidates?: {
        type?: string;
        items?: unknown;
        minItems?: number;
        maxItems?: number;
      };
    };
  };
  const candidateArray = jsonSchema.properties?.candidates;
  expect(candidateArray).toMatchObject({ type: "array", minItems: 3, maxItems: 3 });
  expect(Array.isArray(candidateArray?.items)).toBe(false);
});

test("retries and rejects provider output with the wrong strategy order", async () => {
  const wrongOrder = {
    candidates: [
      { strategy: "emotion_signal", text: "기다리면서 조금 아쉬웠어", intentLabel: "서운함 신호", riskLabel: null },
      { strategy: "relationship_soft", text: "바빴구나, 다음엔 말해줘", intentLabel: "관계 유지", riskLabel: null },
      { strategy: "clearer_request", text: "늦을 때는 미리 알려줘", intentLabel: "다음 행동 요청", riskLabel: null },
    ],
  };
  const requests: StructuredModelRequest<unknown>[] = [];
  const gateway: ModelGateway = {
    async extract<T>(request: StructuredModelRequest<T>): Promise<T> {
      requests.push(request as StructuredModelRequest<unknown>);
      return wrongOrder as T;
    },
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map(() => [1]);
    },
  };

  await expect(generateReplies(command, dependencies(gateway))).rejects.toMatchObject({
    name: "ReplyGenerationValidationError",
    ruleIds: ["OUTPUT_STRUCTURE"],
  });
  expect(requests).toHaveLength(2);
  expect(JSON.parse(requests[1]!.input).validationRuleIds).toEqual(["OUTPUT_STRUCTURE"]);
});

test("does not infer personal devices from the pasted conversation alone", async () => {
  const gateway = new FakeGateway([candidates([
    "바빴구나, 다음엔 말해줘",
    "기다리면서 조금 아쉬웠어",
    "늦을 때는 미리 알려줘",
  ])]);
  const noDeviceContext = {
    ...context,
    roomMemory: "평소 짧고 차분하게 답한다",
    participantProfiles: [{ kind: "speech_pattern", value: "문장 부호를 거의 쓰지 않는다" }],
  };

  await generateReplies(
    { ...command, pastedConversation: `${command.pastedConversation}\n상대: ㅋㅋ` },
    {
      gateway,
      contextProvider: { load: async () => noDeviceContext },
      factValidator: () => true,
    },
  );

  expect(gateway.requests[0]!.system).not.toContain('"laughter"');
});

test("retries expressive devices that room and participant memory do not support", async () => {
  const gateway = new FakeGateway([
    candidates(["바빴구나 ㅋㅋ", "조금 아쉬웠어 😊", "다음엔 알려줘~"]),
    candidates(["바빴구나, 다음엔 말해줘", "기다리면서 조금 아쉬웠어", "늦을 때는 미리 알려줘"]),
  ]);
  const noDeviceContext = {
    ...context,
    roomMemory: "평소 짧고 차분하게 답한다",
    participantProfiles: [{ kind: "speech_pattern", value: "문장 부호를 거의 쓰지 않는다" }],
  };

  await generateReplies(command, {
    gateway,
    contextProvider: { load: async () => noDeviceContext },
    factValidator: () => true,
  });

  expect(JSON.parse(gateway.requests[1]!.input).validationRuleIds).toEqual([
    "UNSUPPORTED_PERSONAL_DEVICE",
  ]);
});

test("retries a friend-romance violation using rule IDs without echoing rejected text", async () => {
  const rejectedText = "PRIVATE_REJECTED 사실 너 좋아해, 설레";
  const gateway = new FakeGateway([
    candidates([rejectedText, "조금 서운하긴 했어", "다음엔 알려줘"]),
    candidates(["바빴구나, 다음엔 말해줘", "조금 기다리게 돼서 아쉬웠어", "늦으면 미리 알려줘"]),
  ]);

  await expect(generateReplies(command, dependencies(gateway))).resolves.toMatchObject({ kind: "replies" });

  expect(gateway.requests).toHaveLength(2);
  const retryInput = gateway.requests[1]!.input;
  expect(JSON.parse(retryInput).validationRuleIds).toEqual(["RELATIONSHIP_FORBIDDEN_CUE"]);
  expect(retryInput).not.toContain("PRIVATE_REJECTED");
});

test("rejects punctuation-only duplicates and unsupported specific facts before one retry", async () => {
  const gateway = new FakeGateway([
    candidates(["다음엔 알려줘!", "다음엔 알려줘...", "오후 7시에 알려줘"]),
    candidates(["바빴구나, 다음엔 말해줘", "기다리면서 조금 아쉬웠어", "늦을 때는 미리 알려줘"]),
  ]);

  await generateReplies(command, dependencies(gateway));

  expect(JSON.parse(gateway.requests[1]!.input).validationRuleIds).toEqual([
    "DUPLICATE_TEXT",
    "UNSUPPORTED_SPECIFIC_FACT",
  ]);
});

test("uses an injected fact check to retry contradictions without exposing fact text in feedback", async () => {
  const gateway = new FakeGateway([
    candidates(["사실은 안 늦었잖아", "조금 아쉬웠어", "다음엔 말해줘"]),
    candidates(["바빴구나, 다음엔 말해줘", "기다리면서 조금 아쉬웠어", "늦을 때는 미리 알려줘"]),
  ]);
  const factValidator = vi.fn((candidate: ReplyCandidateContent) => !candidate.text.includes("안 늦었"));

  await generateReplies(command, dependencies(gateway, { factValidator }));

  expect(JSON.parse(gateway.requests[1]!.input).validationRuleIds).toEqual(["FACT_CONTRADICTION"]);
  expect(gateway.requests[1]!.input).not.toContain("사실은 안 늦었잖아");
});

test("level-five money refusal remains unambiguous in every strategy", async () => {
  const moneyCommand = { ...command, intent: "money_refusal", indirectness: 5 as const };
  const vague = candidates(["이번엔 조금 생각해볼게", "살짝 부담되긴 하네", "나중에 얘기해보자"]);
  const clear = candidates([
    "미안한데 이번 돈은 빌려주지 못해",
    "돈 얘기라 조심스럽지만 이번에는 못 해",
    "이번에는 돈을 빌려주기 어려워서 안 될 것 같아",
  ]);
  const gateway = new FakeGateway([vague, clear]);

  const result = await generateReplies(moneyCommand, dependencies(gateway));

  expect(result.kind).toBe("replies");
  expect(JSON.parse(gateway.requests[1]!.input).validationRuleIds).toEqual(["EXPLICIT_INTENT_AMBIGUOUS"]);
});

test("a consent boundary requires an explicit refusal rather than a vague question", async () => {
  const consentCommand = { ...command, intent: "consent_boundary", indirectness: 5 as const };
  const gateway = new FakeGateway([
    candidates(["이거 괜찮아?", "조금 생각해볼까?", "나중에 얘기할까?"]),
    candidates([
      "미안하지만 스킨십은 원하지 않아",
      "나는 이건 싫어, 여기서 멈춰줘",
      "지금은 동의하지 않아, 하지 말아줘",
    ]),
  ]);

  await generateReplies(consentCommand, dependencies(gateway));

  expect(JSON.parse(gateway.requests[1]!.input).validationRuleIds).toEqual(["EXPLICIT_INTENT_AMBIGUOUS"]);
});

test("a safety plan requires a concrete safe action rather than the word danger", async () => {
  const safetyCommand = { ...command, intent: "safety_plan", indirectness: 5 as const };
  const gateway = new FakeGateway([
    candidates(["좀 위험하긴 하네 112", "119", "그건 위험해 보여"]),
    candidates([
      "오늘은 혼자 안 갈게",
      "안전한 길로 가고 도착하면 연락할게",
      "위험하면 바로 도움 요청할게",
    ]),
  ]);

  await generateReplies(safetyCommand, dependencies(gateway));

  expect(JSON.parse(gateway.requests[1]!.input).validationRuleIds).toEqual(["EXPLICIT_INTENT_AMBIGUOUS"]);
});

test("an important promise change cannot pass as an unchanged commitment", async () => {
  const promiseCommand = { ...command, intent: "important_promise_change", indirectness: 5 as const };
  const gateway = new FakeGateway([
    candidates(["약속 변경은 못 할 것 같아", "예약 취소는 할 수 없어", "그 약속 취소는 안 할게"]),
    candidates([
      "이번 약속은 변경해야 할 것 같아",
      "약속을 미루고 새로 정하고 싶어",
      "예약을 바꿔야 해서 다시 맞춰보자",
    ]),
  ]);

  await generateReplies(promiseCommand, dependencies(gateway));

  expect(JSON.parse(gateway.requests[1]!.input).validationRuleIds).toEqual(["EXPLICIT_INTENT_AMBIGUOUS"]);
});

test("a positive money decision is validated as acceptance rather than forced into refusal", async () => {
  const paymentCommand = { ...command, intent: "money_payment_acceptance", indirectness: 5 as const };
  const gateway = new FakeGateway([candidates([
    "그 돈은 오늘 보낼게",
    "금액 확인하고 송금할게",
    "이번 금액은 내가 송금할게",
  ])]);

  await expect(generateReplies(paymentCommand, dependencies(gateway))).resolves.toMatchObject({ kind: "replies" });
  expect(gateway.requests).toHaveLength(1);
});

test("preserves both sides of a shared-versus-personal expense boundary", async () => {
  const allocationCommand = {
    ...command,
    intent: "같이 하는 활동은 돈을 한번에 걷되 개인적인 쇼핑은 알아서 쓰는 거를 말하고 싶어",
  };
  const gateway = new FakeGateway([candidates([
    "같이 하는 활동비는 한 번에 걷고 개인 쇼핑은 각자 부담하는 걸로 하자",
    "공동으로 쓰는 돈은 모아서 정산하고 쇼핑 비용은 각자 내면 좋겠어",
    "활동 비용은 같이 걷고 개인적으로 사는 건 각자 알아서 쓰자",
  ])]);

  await expect(generateReplies(allocationCommand, dependencies(gateway)))
    .resolves.toMatchObject({ kind: "replies" });
  expect(gateway.requests).toHaveLength(1);
});

test("rejects an expense-allocation reply that omits the personal-expense boundary", async () => {
  const allocationCommand = {
    ...command,
    intent: "같이 하는 활동은 돈을 한번에 걷되 개인적인 쇼핑은 알아서 쓰는 거를 말하고 싶어",
  };
  const incomplete = candidates([
    "같이 하는 활동비는 한 번에 걷자",
    "공동 비용은 모아서 정산하자",
    "활동 비용은 같이 내자",
  ]);
  const gateway = new FakeGateway([incomplete, incomplete]);

  await expect(generateReplies(allocationCommand, dependencies(gateway))).rejects.toMatchObject({
    ruleIds: ["EXPLICIT_INTENT_AMBIGUOUS"],
  });
  expect(JSON.parse(gateway.requests[1]!.input).validationRuleIds)
    .toEqual(["EXPLICIT_INTENT_AMBIGUOUS"]);
});

test("returns one clarification question without calling the model", async () => {
  const gateway = new FakeGateway([]);
  const ambiguousContext: ReplyGenerationContext = {
    ...context,
    currentContext: {
      turns: context.currentContext.turns,
      usedTurnLimit: "full_chunk",
      needsUserQuestion: true,
      question: "어떤 약속을 말하는지 알려줄래?",
    },
  };

  const result = await generateReplies(command, {
    gateway,
    contextProvider: { load: async () => ambiguousContext },
    factValidator: () => true,
  });

  expect(result).toEqual({ kind: "clarification_required", question: "어떤 약속을 말하는지 알려줄래?" });
  expect(gateway.requests).toHaveLength(0);
});

test("fails closed after the single validation retry and exposes rule IDs only", async () => {
  const privateText = "PRIVATE_BAD 사랑해 자기야";
  const gateway = new FakeGateway([
    candidates([privateText, "조금 아쉬워", "다음엔 알려줘"]),
    candidates([privateText, "조금 아쉬워", "다음엔 알려줘"]),
  ]);

  try {
    await generateReplies(command, dependencies(gateway));
    expect.unreachable("unsafe candidates must not be returned");
  } catch (error) {
    expect(error).toBeInstanceOf(ReplyGenerationValidationError);
    expect((error as ReplyGenerationValidationError).ruleIds).toEqual(["RELATIONSHIP_FORBIDDEN_CUE"]);
    expect(String(error)).not.toContain("PRIVATE_BAD");
  }
  expect(gateway.requests).toHaveLength(2);
});
