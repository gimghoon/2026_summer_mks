import { z } from "zod";

import type { StructuredModelRequest, ModelGateway } from "@/domain/models/gateway";
import {
  generateReplies,
  ReplyGenerationValidationError,
  type GenerateRepliesCommand,
  type ReplyCandidateContent,
  type ReplyGenerationContext,
  type ParticipantProfileContext,
  type ReplyServiceDependencies,
} from "@/domain/replies/reply-service";
import { PERSONAL_CONTEXT_UNAVAILABLE_MESSAGE } from "@/domain/replies/required-personal-context";

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
  personalContextMode: "normal",
};

function profile(overrides: Partial<ParticipantProfileContext> = {}): ParticipantProfileContext {
  return {
    id: "fact-profile",
    kind: "speech_pattern",
    value: "짧고 부드럽게 말한다",
    source: "user_confirmed",
    locked: true,
    ...overrides,
  };
}

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
  participantProfiles: [profile()],
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

function dependencies(
  gateway: ModelGateway,
  extra: Partial<ReplyServiceDependencies> = {},
): ReplyServiceDependencies {
  const {
    contextProvider = {
      loadParticipantProfiles: vi.fn(async () => context.participantProfiles),
      load: vi.fn(async () => context),
    },
    factValidator = vi.fn(() => true),
    personalContextUsageValidator = alwaysReflected,
  } = extra;
  return {
    gateway,
    contextProvider,
    factValidator,
    personalContextUsageValidator,
  };
}

const trustedFacts = [profile({
  id: "trusted-id",
  value: "PRIVATE_TRUSTED_VALUE 짧고 부드럽게 답한다",
  source: "user_confirmed",
  locked: true,
})];
const inferredFacts = [profile({
  id: "inferred-id",
  value: "PRIVATE_INFERRED_VALUE 말끝을 부드럽게 한다",
  source: "ai_inference",
  locked: false,
})];
const trustedAndInferredFacts = [...trustedFacts, ...inferredFacts];

function requiredTuple(contextBasisIds: [string[], string[], string[]] = [
  ["trusted-id"], ["trusted-id"], ["trusted-id"],
]) {
  return candidates([
    "바빴구나, 다음엔 한마디만 해주면 좋을 것 같아",
    "기다리면서 조금 아쉬웠어",
    "늦을 것 같으면 미리 알려줘",
  ], contextBasisIds);
}

const alwaysReflected = vi.fn<ReplyServiceDependencies["personalContextUsageValidator"]>(async () => ({
  relationship_soft: true,
  emotion_signal: true,
  clearer_request: true,
}));

const invalidAdvisoryResponse = candidates([
  "사랑해 자기야, 무조건 보내, 오후 7시에~",
  "공동 비용은 걷고 개인 쇼핑은 각자 내자",
  "공동 비용은 걷고 개인 쇼핑은 각자 내자",
]);

const protectedAllocationCommand: GenerateRepliesCommand = {
  ...command,
  intent: "공동 비용은 걷고 개인 쇼핑은 각자 내자고 말하고 싶어",
};

const newlyProtectedMoneyIntents = [
  "돈 좀 보내줘",
  "이번 송금을 수락하고 싶어",
  "내일 갚겠다고 말하고 싶어",
  "이번에는 내가 결제할게",
  "돈은 내가 받을게",
] as const;

const clearNaturalMoneyDecisions = [
  ["돈 좀 보내줘", "돈 좀 보내줘"],
  ["이번 송금을 수락하고 싶어", "이번 송금은 내가 받을게"],
  ["내일 갚겠다고 말하고 싶어", "내일 내가 갚을게"],
  ["이번에는 내가 결제할게", "이번에는 내가 결제할게"],
  ["돈은 내가 받을게", "돈은 내가 받을게"],
] as const;

const vagueMoneyResponse = candidates([
  "이번에는 조금 생각해볼게",
  "조금 고민되기는 하네",
  "나중에 다시 이야기하자",
]);

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

test("returns unavailable before generation when required mode has no eligible fact", async () => {
  const gateway = new FakeGateway([requiredTuple()]);
  const extract = vi.spyOn(gateway, "extract");
  const embed = vi.spyOn(gateway, "embed");
  const semantic = vi.fn();
  const contextProvider = {
    loadParticipantProfiles: vi.fn(async () => []),
    load: vi.fn(async () => context),
  };

  const result = await generateReplies(
    { ...command, personalContextMode: "required", indirectness: 7 },
    { gateway, contextProvider, factValidator: () => true, personalContextUsageValidator: semantic },
  );

  expect(result).toEqual({
    kind: "personal_context_unavailable",
    message: PERSONAL_CONTEXT_UNAVAILABLE_MESSAGE,
  });
  expect(extract).not.toHaveBeenCalled();
  expect(embed).not.toHaveBeenCalled();
  expect(semantic).not.toHaveBeenCalled();
  expect(contextProvider.load).not.toHaveBeenCalled();
});

test.each([
  [[], "empty"],
  [["unknown"], "unknown"],
  [["inferred-id"], "inference while trusted exists"],
])("retries required mode with opaque basis rule for %s", async (basisIds) => {
  const gateway = new FakeGateway([
    requiredTuple([basisIds, basisIds, basisIds]),
    requiredTuple(),
  ]);
  const contextProvider = {
    loadParticipantProfiles: vi.fn(async () => trustedAndInferredFacts),
    load: vi.fn(async (_command, preloadedProfiles) => ({
      ...context,
      participantProfiles: preloadedProfiles ?? trustedAndInferredFacts,
    })),
  };

  const result = await generateReplies(
    { ...command, personalContextMode: "required" },
    {
      gateway,
      contextProvider,
      factValidator: () => true,
      personalContextUsageValidator: alwaysReflected,
    },
  );

  expect(result.kind).toBe("replies");
  expect(JSON.parse(gateway.requests[1]!.input).validationRuleIds)
    .toEqual(["REQUIRED_PERSONAL_CONTEXT_MISSING"]);
});

test("checks all three required candidates in one semantic call and retries opaquely", async () => {
  const semantic = vi.fn<ReplyServiceDependencies["personalContextUsageValidator"]>()
    .mockResolvedValueOnce({ relationship_soft: true, emotion_signal: false, clearer_request: true })
    .mockResolvedValueOnce({ relationship_soft: true, emotion_signal: true, clearer_request: true });
  const gateway = new FakeGateway([requiredTuple(), requiredTuple()]);
  const result = await generateReplies(
    { ...command, personalContextMode: "required", indirectness: 7 },
    dependencies(gateway, {
      contextProvider: {
        loadParticipantProfiles: vi.fn(async () => trustedFacts),
        load: vi.fn(async (_command, preloadedProfiles) => ({
          ...context,
          participantProfiles: preloadedProfiles ?? trustedFacts,
        })),
      },
      personalContextUsageValidator: semantic,
    }),
  );

  expect(result.kind).toBe("replies");
  expect(semantic).toHaveBeenCalledTimes(2);
  expect(semantic.mock.calls[0]![0]).toHaveLength(3);
  expect(JSON.parse(gateway.requests[1]!.input).validationRuleIds)
    .toEqual(["PERSONAL_CONTEXT_NOT_REFLECTED"]);
  expect(JSON.stringify(JSON.parse(gateway.requests[1]!.input).validationRuleIds))
    .not.toContain("PRIVATE_TRUSTED_VALUE");
});

test("retries a conditional use that invents an ungrounded state", async () => {
  const conditionalFacts = [profile({
    id: "conditional-id",
    value: "상대 상태를 단정하지 않고 질문한다",
    conditions: ["상대가 피곤하다고 말했을 때는 휴식을 권한다"],
    source: "user_edited",
    locked: true,
  })];
  const semantic = vi.fn<ReplyServiceDependencies["personalContextUsageValidator"]>(
    async (semanticCandidates, grounding) => ({
      relationship_soft: !semanticCandidates[0].text.includes("피곤")
        || JSON.stringify(grounding).includes("피곤"),
      emotion_signal: true,
      clearer_request: true,
    }),
  );
  const gateway = new FakeGateway([
    candidates([
      "피곤해 보이니까 오늘은 푹 쉬어",
      "오늘 답이 늦어서 조금 아쉬웠어",
      "다음에는 늦을 때 미리 알려줘",
    ], [["conditional-id"], ["conditional-id"], ["conditional-id"]]),
    candidates([
      "무슨 일 있었는지 물어봐도 될까",
      "오늘 답이 늦어서 조금 아쉬웠어",
      "다음에는 늦을 때 미리 알려줘",
    ], [["conditional-id"], ["conditional-id"], ["conditional-id"]]),
  ]);

  const result = await generateReplies(
    { ...command, personalContextMode: "required" },
    dependencies(gateway, {
      contextProvider: {
        loadParticipantProfiles: async () => conditionalFacts,
        load: async (_command, preloadedProfiles) => ({
          ...context,
          participantProfiles: preloadedProfiles ?? conditionalFacts,
        }),
      },
      personalContextUsageValidator: semantic,
    }),
  );

  expect(result.kind).toBe("replies");
  expect(semantic).toHaveBeenCalledTimes(2);
  expect(semantic.mock.calls[0]![1]).toEqual({
    situation: command.situation,
    intent: command.intent,
    currentTurns: [{
      speakerId: "participant-1",
      messages: [{ kind: "text", text: "오늘 답이 늦어서 미안해" }],
    }],
  });
  expect(JSON.parse(gateway.requests[1]!.input).validationRuleIds)
    .toEqual(["PERSONAL_CONTEXT_NOT_REFLECTED"]);
});

test("accepts a conditional use when the selected current situation grounds it", async () => {
  const groundedCommand = {
    ...command,
    situation: "상대가 오늘 피곤하다고 말해서 쉬도록 배려하고 싶다",
    personalContextMode: "required" as const,
  };
  const conditionalFacts = [profile({
    id: "conditional-id",
    value: "상대가 피곤할 때는 짧게 휴식을 권한다",
    conditions: ["상대가 피곤하다고 말했을 때"],
    source: "user_edited",
    locked: true,
  })];
  const semantic = vi.fn<ReplyServiceDependencies["personalContextUsageValidator"]>(
    async (_semanticCandidates, grounding) => ({
      relationship_soft: JSON.stringify(grounding).includes("피곤"),
      emotion_signal: true,
      clearer_request: true,
    }),
  );
  const gateway = new FakeGateway([candidates([
    "피곤하다 했으니 오늘은 푹 쉬어",
    "오늘 많이 지쳤겠다, 편히 쉬어",
    "오늘은 쉬고 내일 이야기하자",
  ], [["conditional-id"], ["conditional-id"], ["conditional-id"]])]);

  const result = await generateReplies(groundedCommand, dependencies(gateway, {
    contextProvider: {
      loadParticipantProfiles: async () => conditionalFacts,
      load: async (_command, preloadedProfiles) => ({
        ...context,
        participantProfiles: preloadedProfiles ?? conditionalFacts,
      }),
    },
    personalContextUsageValidator: semantic,
  }));

  expect(result.kind).toBe("replies");
  expect(gateway.requests).toHaveLength(1);
  expect(semantic).toHaveBeenCalledTimes(1);
});

test("uses independent selected fact IDs per required strategy", async () => {
  const facts = [
    profile({ id: "trusted-a", value: "A", source: "user_confirmed", locked: true }),
    profile({ id: "trusted-b", value: "B", source: "user_confirmed", locked: true }),
    profile({ id: "trusted-c", value: "C", source: "user_confirmed", locked: true }),
  ];
  const semantic = vi.fn<ReplyServiceDependencies["personalContextUsageValidator"]>(async () => ({ relationship_soft: true, emotion_signal: true, clearer_request: true }));
  const gateway = new FakeGateway([requiredTuple([["trusted-a"], ["trusted-b"], ["trusted-c"]])]);

  await generateReplies({ ...command, personalContextMode: "required" }, dependencies(gateway, {
    contextProvider: {
      loadParticipantProfiles: async () => facts,
      load: async (_command, preloadedProfiles) => ({ ...context, participantProfiles: preloadedProfiles ?? facts }),
    },
    personalContextUsageValidator: semantic,
  }));

  expect(semantic.mock.calls[0]![0].map((candidate: { selectedFacts: Array<{ id: string }> }) => (
    candidate.selectedFacts[0]!.id
  ))).toEqual(["trusted-a", "trusted-b", "trusted-c"]);
});

test("sends only selected required facts to the generation model", async () => {
  const gateway = new FakeGateway([requiredTuple()]);
  await generateReplies({ ...command, personalContextMode: "required" }, dependencies(gateway, {
    contextProvider: {
      loadParticipantProfiles: async () => trustedAndInferredFacts,
      load: async () => ({
        ...context,
        participantProfiles: trustedAndInferredFacts,
        currentFacts: trustedAndInferredFacts.map((fact) => fact.value),
      }),
    },
    personalContextUsageValidator: alwaysReflected,
  }));

  const input = JSON.parse(gateway.requests[0]!.input);
  expect(input.personalContextEvidence.map((fact: { id: string }) => fact.id)).toEqual(["trusted-id"]);
  expect(input.context.participantProfiles.map((fact: { id: string }) => fact.id)).toEqual(["trusted-id"]);
  expect(input.context.currentFacts).toEqual([]);
  expect(gateway.requests[0]!.input).not.toContain("PRIVATE_INFERRED_VALUE");
});

test("permits every required strategy to reuse the same best fact", async () => {
  const gateway = new FakeGateway([requiredTuple()]);
  const semantic = vi.fn<ReplyServiceDependencies["personalContextUsageValidator"]>(async () => ({ relationship_soft: true, emotion_signal: true, clearer_request: true }));

  await expect(generateReplies({ ...command, personalContextMode: "required" }, dependencies(gateway, {
    contextProvider: {
      loadParticipantProfiles: async () => trustedFacts,
      load: async (_command, preloadedProfiles) => ({ ...context, participantProfiles: preloadedProfiles ?? trustedFacts }),
    },
    personalContextUsageValidator: semantic,
  }))).resolves.toMatchObject({ kind: "replies" });
  expect(semantic.mock.calls[0]![0].map((candidate: { selectedFacts: Array<{ id: string }> }) => (
    candidate.selectedFacts[0]!.id
  ))).toEqual(["trusted-id", "trusted-id", "trusted-id"]);
});

test("adds an inference warning to every candidate when required selection is inference-only", async () => {
  const gateway = new FakeGateway([candidates([
    "바빴구나, 다음엔 말해줘",
    "기다리면서 조금 아쉬웠어",
    "늦을 때는 미리 알려줘",
  ], [["inferred-id"], ["inferred-id"], ["inferred-id"]])]);

  const result = await generateReplies({ ...command, personalContextMode: "required" }, dependencies(gateway, {
    contextProvider: {
      loadParticipantProfiles: async () => inferredFacts,
      load: async (_command, preloadedProfiles) => ({ ...context, participantProfiles: preloadedProfiles ?? inferredFacts }),
    },
    personalContextUsageValidator: alwaysReflected,
  }));

  expect(result).toMatchObject({ kind: "replies" });
  if (result.kind !== "replies") return;
  expect(result.candidates.map((candidate) => candidate.warnings)).toEqual([
    ["unverified_profile_context"],
    ["unverified_profile_context"],
    ["unverified_profile_context"],
  ]);
});

test("fails closed after a second semantic failure without leaking profile facts or rejected text", async () => {
  const rejectedText = "PRIVATE_REJECTED_SEMANTIC_TEXT";
  const gateway = new FakeGateway([
    candidates([rejectedText, "기다리면서 조금 아쉬웠어", "늦을 때는 미리 알려줘"], [["trusted-id"], ["trusted-id"], ["trusted-id"]]),
    candidates([rejectedText, "기다리면서 조금 아쉬웠어", "늦을 때는 미리 알려줘"], [["trusted-id"], ["trusted-id"], ["trusted-id"]]),
  ]);
  const semantic = vi.fn<ReplyServiceDependencies["personalContextUsageValidator"]>(async () => ({ relationship_soft: false, emotion_signal: true, clearer_request: true }));

  try {
    await generateReplies({ ...command, personalContextMode: "required" }, dependencies(gateway, {
      contextProvider: {
        loadParticipantProfiles: async () => trustedFacts,
        load: async (_command, preloadedProfiles) => ({ ...context, participantProfiles: preloadedProfiles ?? trustedFacts }),
      },
      personalContextUsageValidator: semantic,
    }));
    expect.unreachable("the second semantic failure must reject");
  } catch (error) {
    expect(error).toMatchObject({ ruleIds: ["PERSONAL_CONTEXT_NOT_REFLECTED"] });
    expect(String(error)).not.toContain("PRIVATE_TRUSTED_VALUE");
    expect(String(error)).not.toContain(rejectedText);
  }
  const retryRules = JSON.stringify(JSON.parse(gateway.requests[1]!.input).validationRuleIds);
  expect(retryRules).not.toContain("PRIVATE_TRUSTED_VALUE");
  expect(retryRules).not.toContain(rejectedText);
});

test("normal mode neither calls semantic validation nor adds inference warnings", async () => {
  const semantic = vi.fn<ReplyServiceDependencies["personalContextUsageValidator"]>(async () => { throw new Error("must not run"); });
  const gateway = new FakeGateway([requiredTuple()]);
  const result = await generateReplies(command, dependencies(gateway, {
    contextProvider: {
      loadParticipantProfiles: async () => inferredFacts,
      load: async () => ({ ...context, participantProfiles: inferredFacts }),
    },
    personalContextUsageValidator: semantic,
  }));

  expect(result.kind).toBe("replies");
  expect(semantic).not.toHaveBeenCalled();
});

test("exposes verified profile evidence for known IDs and a fixed fallback for unknown IDs", async () => {
  const gateway = new FakeGateway([candidates([
    "바빴구나, 다음엔 한마디만 해주면 좋을 것 같아",
    "괜찮긴 한데 기다리면서 살짝 신경 쓰이긴 했어",
    "다음부터 늦을 것 같으면 미리 알려줘",
  ], [["fact-profile"], ["invented"], []])]);

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
    { id: "fact-profile", summary: "speech_pattern: 짧고 부드럽게 말한다" },
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

test.each(newlyProtectedMoneyIntents)(
  "level five keeps a natural money decision strict: %s",
  async (intent) => {
    const gateway = new FakeGateway([vagueMoneyResponse, vagueMoneyResponse]);

    await expect(generateReplies(
      { ...command, intent, indirectness: 5 },
      dependencies(gateway),
    )).rejects.toMatchObject({
      ruleIds: ["EXPLICIT_INTENT_AMBIGUOUS"],
    });
    expect(gateway.requests).toHaveLength(2);
    expect(JSON.parse(gateway.requests[1]!.input).validationRuleIds).toEqual([
      "EXPLICIT_INTENT_AMBIGUOUS",
    ]);
  },
);

test.each(newlyProtectedMoneyIntents)(
  "level seven warns for an ambiguous natural money decision without retrying: %s",
  async (intent) => {
    const gateway = new FakeGateway([vagueMoneyResponse]);

    const result = await generateReplies(
      { ...command, intent, indirectness: 7 },
      dependencies(gateway),
    );

    expect(result.kind).toBe("replies");
    if (result.kind !== "replies") return;
    expect(gateway.requests).toHaveLength(1);
    for (const candidate of result.candidates) {
      expect(candidate.warnings).toEqual([
        "emotional_inference",
        "important_intent_ambiguity",
      ]);
    }
  },
);

test.each(clearNaturalMoneyDecisions)(
  "level five accepts an explicit natural money decision without retrying: %s",
  async (intent, explicitReply) => {
    const clearResponse = candidates([
      explicitReply,
      `확실히 말할게, ${explicitReply}`,
      `${explicitReply}라고 전할게`,
    ]);
    const gateway = new FakeGateway([clearResponse, clearResponse]);

    await expect(generateReplies(
      { ...command, intent, indirectness: 5 },
      dependencies(gateway),
    )).resolves.toMatchObject({ kind: "replies" });
    expect(gateway.requests).toHaveLength(1);
  },
);

test("level five does not confuse a non-financial send with an explicit money decision", async () => {
  const nonFinancialSend = candidates([
    "답장은 내가 보낼게",
    "메시지는 내가 보낼게",
    "사진은 내가 보낼게",
  ]);
  const gateway = new FakeGateway([nonFinancialSend, nonFinancialSend]);

  await expect(generateReplies(
    { ...command, intent: "돈은 내가 받을게", indirectness: 5 },
    dependencies(gateway),
  )).rejects.toMatchObject({
    ruleIds: ["EXPLICIT_INTENT_AMBIGUOUS"],
  });
});

test("level five does not confuse a non-financial send request with a money request", async () => {
  const nonFinancialRequest = candidates([
    "사진 좀 보내줘",
    "메시지 보내줘",
    "파일 보내줘",
  ]);
  const gateway = new FakeGateway([nonFinancialRequest, nonFinancialRequest]);

  await expect(generateReplies(
    { ...command, intent: "돈 좀 보내줘", indirectness: 5 },
    dependencies(gateway),
  )).rejects.toMatchObject({
    ruleIds: ["EXPLICIT_INTENT_AMBIGUOUS"],
  });
  expect(gateway.requests).toHaveLength(2);
});

test("level seven warns without retrying for non-financial send requests", async () => {
  const nonFinancialRequest = candidates([
    "사진 좀 보내줘",
    "메시지 보내줘",
    "파일 보내줘",
  ]);
  const gateway = new FakeGateway([nonFinancialRequest]);

  const result = await generateReplies(
    { ...command, intent: "돈 좀 보내줘", indirectness: 7 },
    dependencies(gateway),
  );

  expect(result.kind).toBe("replies");
  if (result.kind !== "replies") return;
  expect(gateway.requests).toHaveLength(1);
  for (const candidate of result.candidates) {
    expect(candidate.warnings).toEqual([
      "emotional_inference",
      "important_intent_ambiguity",
    ]);
  }
});

test.each([
  "회비 좀 보내줘",
  "비용 보내줘",
  "계좌로 보내줘",
])("level five accepts an explicit contextual money request: %s", async (explicitRequest) => {
  const explicitResponse = candidates([
    explicitRequest,
    `확실히 말할게, ${explicitRequest}`,
    `${explicitRequest}라고 전할게`,
  ]);
  const gateway = new FakeGateway([explicitResponse]);

  await expect(generateReplies(
    { ...command, intent: explicitRequest, indirectness: 5 },
    dependencies(gateway),
  )).resolves.toMatchObject({ kind: "replies" });
  expect(gateway.requests).toHaveLength(1);
});

test.each([
  "회비 좀 보내줘",
  "비용 보내줘",
  "계좌로 보내줘",
])("level seven does not warn about an explicit contextual money request: %s", async (explicitRequest) => {
  const explicitResponse = candidates([
    explicitRequest,
    `확실히 말할게, ${explicitRequest}`,
    `${explicitRequest}라고 전할게`,
  ]);
  const gateway = new FakeGateway([explicitResponse]);

  const result = await generateReplies(
    { ...command, intent: explicitRequest, indirectness: 7 },
    dependencies(gateway),
  );

  expect(result.kind).toBe("replies");
  if (result.kind !== "replies") return;
  expect(gateway.requests).toHaveLength(1);
  for (const candidate of result.candidates) {
    expect(candidate.warnings).not.toContain("important_intent_ambiguity");
  }
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
    participantProfiles: [profile({ value: "문장 부호를 거의 쓰지 않는다" })],
  };

  await generateReplies(
    { ...command, pastedConversation: `${command.pastedConversation}\n상대: ㅋㅋ` },
    {
      gateway,
      contextProvider: {
        loadParticipantProfiles: async () => noDeviceContext.participantProfiles,
        load: async () => noDeviceContext,
      },
      factValidator: () => true,
      personalContextUsageValidator: alwaysReflected,
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
    participantProfiles: [profile({ value: "문장 부호를 거의 쓰지 않는다" })],
  };

  await generateReplies(command, {
    gateway,
    contextProvider: {
      loadParticipantProfiles: async () => noDeviceContext.participantProfiles,
      load: async () => noDeviceContext,
    },
    factValidator: () => true,
    personalContextUsageValidator: alwaysReflected,
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
    contextProvider: {
      loadParticipantProfiles: async () => ambiguousContext.participantProfiles,
      load: async () => ambiguousContext,
    },
    factValidator: () => true,
    personalContextUsageValidator: alwaysReflected,
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
