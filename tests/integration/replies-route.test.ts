import {
  createReplyPostHandler,
} from "@/domain/replies/reply-api-handler";
import {
  ReplyGenerationValidationError,
  type ReplyCandidate,
} from "@/domain/replies/reply-service";

const roomId = "11111111-1111-4111-8111-111111111111";
const participantId = "22222222-2222-4222-8222-222222222222";

const candidates: [ReplyCandidate, ReplyCandidate, ReplyCandidate] = [
  { strategy: "relationship_soft", text: "다음에는 미리 말해주면 좋겠어", intentLabel: "관계 유지", riskLabel: null },
  { strategy: "emotion_signal", text: "조금 기다리면서 아쉬웠어", intentLabel: "감정 전달", riskLabel: "돌려 들릴 수 있어" },
  { strategy: "clearer_request", text: "늦을 때는 한마디만 해줘", intentLabel: "요청", riskLabel: null },
];

function request(body: unknown): Request {
  return new Request("https://assistant.test/api/replies", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    roomId,
    participantId,
    pastedConversation: "상대: 답이 늦어서 미안해\n나: 괜찮아",
    situation: "차분히 아쉬움을 말하고 싶다",
    intent: "apology_prompt",
    ...overrides,
  };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    requireSession: vi.fn(async () => {}),
    isRoomReady: vi.fn(async () => true),
    loadParticipant: vi.fn(async () => ({ relationship: "female_friend" as const })),
    generate: vi.fn(async () => ({ kind: "replies" as const, candidates })),
    persist: vi.fn(async () => {}),
    log: vi.fn(),
    ...overrides,
  };
}

test("reply API requires a session", async () => {
  const handler = createReplyPostHandler(dependencies({
    requireSession: async () => { throw new Response("Unauthorized", { status: 401 }); },
  }));

  expect((await handler(request(validBody()))).status).toBe(401);
});

test("returns exactly three candidates and uses the saved default indirectness", async () => {
  const deps = dependencies();
  const handler = createReplyPostHandler(deps);

  const response = await handler(request(validBody()));

  expect(response.status).toBe(200);
  expect((await response.json()).candidates).toHaveLength(3);
  expect(deps.generate).toHaveBeenCalledWith(expect.objectContaining({ indirectness: 3 }), "female_friend");
  expect(deps.persist).toHaveBeenCalledWith(expect.objectContaining({
    relationship: "female_friend",
    candidates: expect.arrayContaining([expect.objectContaining({ text: candidates[0].text })]),
  }));
});

test("uses an explicit per-request relationship override for policy generation and persistence", async () => {
  const deps = dependencies();
  const handler = createReplyPostHandler(deps);

  const response = await handler(request(validBody({ relationship: "girlfriend" })));

  expect(response.status).toBe(200);
  expect(deps.generate).toHaveBeenCalledWith(expect.anything(), "girlfriend");
  expect(deps.persist).toHaveBeenCalledWith(expect.objectContaining({ relationship: "girlfriend" }));
});

test("enforces the pasted conversation limit before generation", async () => {
  const deps = dependencies();
  const handler = createReplyPostHandler(deps);

  const response = await handler(request(validBody({ pastedConversation: "가".repeat(50_001) })));

  expect(response.status).toBe(400);
  expect(deps.generate).not.toHaveBeenCalled();
  expect(deps.persist).not.toHaveBeenCalled();
});

test("returns a clarification without storing a reply request", async () => {
  const deps = dependencies({
    generate: vi.fn(async () => ({
      kind: "clarification_required" as const,
      question: "어떤 약속을 말하는 건지 알려줄래?",
    })),
  });
  const handler = createReplyPostHandler(deps);

  const response = await handler(request(validBody()));

  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toEqual({
    kind: "clarification_required",
    question: "어떤 약속을 말하는 건지 알려줄래?",
  });
  expect(deps.persist).not.toHaveBeenCalled();
});

test("does not generate replies for a participant outside the requested room", async () => {
  const deps = dependencies({ loadParticipant: vi.fn(async () => null) });
  const handler = createReplyPostHandler(deps);

  const response = await handler(request(validBody()));

  expect(response.status).toBe(404);
  expect(deps.generate).not.toHaveBeenCalled();
});

test("blocks direct reply generation until room analysis is ready", async () => {
  const deps = dependencies({ isRoomReady: vi.fn(async () => false) });
  const response = await createReplyPostHandler(deps)(request(validBody()));
  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toEqual({ error: "ANALYSIS_REQUIRED" });
  expect(deps.loadParticipant).not.toHaveBeenCalled();
  expect(deps.generate).not.toHaveBeenCalled();
});

test("does not expose private generation errors", async () => {
  const privateMessage = "민수야 오늘 홍대에서 한 비밀 얘기는 남기지 마";
  const deps = dependencies({
    generate: vi.fn(async () => { throw new Error("PRIVATE_CONVERSATION_TEXT"); }),
  });
  const handler = createReplyPostHandler(deps);

  const response = await handler(request(validBody({ pastedConversation: privateMessage })));

  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain("PRIVATE_CONVERSATION_TEXT");
  expect(deps.log).toHaveBeenCalledWith("reply_request_failed", expect.not.objectContaining({ text: expect.anything() }));
  expect(JSON.stringify(deps.log.mock.calls)).not.toMatch(/PRIVATE_CONVERSATION_TEXT|민수|홍대|비밀/u);
});

test("logs only opaque validation rule IDs for rejected reply candidates", async () => {
  const deps = dependencies({
    generate: vi.fn(async () => {
      throw new ReplyGenerationValidationError([
        "UNSUPPORTED_PERSONAL_DEVICE",
        "FACT_CONTRADICTION",
      ]);
    }),
  });
  const handler = createReplyPostHandler(deps);

  const response = await handler(request(validBody({
    pastedConversation: "PRIVATE_CONVERSATION_TEXT",
  })));

  expect(response.status).toBe(500);
  expect(deps.log).toHaveBeenCalledWith("reply_request_failed", expect.objectContaining({
    failure: "ReplyGenerationValidationError:UNSUPPORTED_PERSONAL_DEVICE|FACT_CONTRADICTION",
  }));
  expect(JSON.stringify(deps.log.mock.calls)).not.toContain("PRIVATE_CONVERSATION_TEXT");
});
