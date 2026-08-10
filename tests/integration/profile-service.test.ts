import {
  ModelResponseValidationError,
  type StructuredModelRequest,
  type ModelGateway,
} from "@/domain/models/gateway";
import { decryptJson, encryptJson } from "@/domain/crypto/encrypted-json";
import {
  extractRoomMemory,
  redactChunkForEmbedding,
  type ChunkMemoryPayload,
  type ChunkMemoryUpdate,
  type MemoryChunk,
  type MemoryRepository,
  type RoomMemoryPayload,
  type RoomParticipantIdentity,
  type StoredChunkMemory,
} from "@/domain/memory/extractor";
import {
  ProfileService,
  type ProfileRepository,
  type StoredProfileFact,
  type StoredProfileRevision,
} from "@/domain/profiles/profile-service";
import type { ProfileFactSource } from "@/db/schema";
import { GET as getProfileRoute } from "@/app/api/profiles/[participantId]/route";

class InMemoryProfileRepository implements ProfileRepository {
  readonly facts: StoredProfileFact[] = [];
  readonly revisions: StoredProfileRevision[] = [];
  private factSequence = 0;
  private revisionSequence = 0;

  async transaction<T>(work: (repository: ProfileRepository) => Promise<T>): Promise<T> {
    const factSnapshot = this.facts.map((fact) => ({ ...fact }));
    const revisionSnapshot = this.revisions.map((revision) => ({ ...revision }));
    const factSequence = this.factSequence;
    const revisionSequence = this.revisionSequence;
    try {
      return await work(this);
    } catch (error) {
      this.facts.splice(0, this.facts.length, ...factSnapshot);
      this.revisions.splice(0, this.revisions.length, ...revisionSnapshot);
      this.factSequence = factSequence;
      this.revisionSequence = revisionSequence;
      throw error;
    }
  }

  async listFacts(participantId: string): Promise<StoredProfileFact[]> {
    return this.facts.filter((fact) => fact.participantId === participantId);
  }

  async findFact(factId: string): Promise<StoredProfileFact | undefined> {
    return this.facts.find((fact) => fact.id === factId);
  }

  async createFact(fact: Omit<StoredProfileFact, "id">): Promise<StoredProfileFact> {
    const created = { ...fact, id: `fact-${++this.factSequence}` };
    this.facts.push(created);
    return created;
  }

  async updateFact(
    factId: string,
    update: Omit<StoredProfileFact, "id" | "participantId" | "kind">,
  ): Promise<StoredProfileFact> {
    const index = this.facts.findIndex((fact) => fact.id === factId);
    if (index === -1) throw new Error("Profile fact not found");
    const updated = { ...this.facts[index]!, ...update };
    this.facts[index] = updated;
    return updated;
  }

  async createRevision(revision: Omit<StoredProfileRevision, "id">): Promise<StoredProfileRevision> {
    const created = { ...revision, id: `revision-${++this.revisionSequence}` };
    this.revisions.push(created);
    return created;
  }

  async findRevision(revisionId: string): Promise<StoredProfileRevision | undefined> {
    return this.revisions.find((revision) => revision.id === revisionId);
  }

  async updateRevisionSource(revisionId: string, source: ProfileFactSource): Promise<void> {
    const revision = this.revisions.find((candidate) => candidate.id === revisionId);
    if (!revision) throw new Error("Profile revision not found");
    revision.source = source;
  }

  async cleanupAiAnalysis(
    analysisKeys: string[],
    legacyEvidenceTurnIds: string[] = [],
  ): Promise<void> {
    const keys = new Set(analysisKeys);
    const legacyEvidence = new Set(legacyEvidenceTurnIds);
    for (let index = this.revisions.length - 1; index >= 0; index -= 1) {
      const revision = this.revisions[index]!;
      const decoded = decryptJson<unknown>(revision.encryptedNextValue);
      const analysisKey = typeof decoded === "object" && decoded !== null
        && "analysisKey" in decoded && typeof decoded.analysisKey === "string"
        ? decoded.analysisKey
        : null;
      const evidenceTurnIds = typeof decoded === "object" && decoded !== null
        && "evidenceTurnIds" in decoded && Array.isArray(decoded.evidenceTurnIds)
        && decoded.evidenceTurnIds.every((turnId) => typeof turnId === "string")
        ? decoded.evidenceTurnIds
        : [];
      const owned = analysisKey !== null && keys.has(analysisKey);
      const legacyProposal = analysisKey === null
        && revision.source === "ai_change_proposal"
        && evidenceTurnIds.length > 0
        && evidenceTurnIds.every((turnId) => legacyEvidence.has(turnId));
      if ((owned && (
        revision.source === "ai_inference" || revision.source === "ai_change_proposal"
      )) || legacyProposal) {
        this.revisions.splice(index, 1);
      }
    }
    for (let index = this.facts.length - 1; index >= 0; index -= 1) {
      const fact = this.facts[index]!;
      const decoded = decryptJson<unknown>(fact.encryptedValue);
      const analysisKey = typeof decoded === "object" && decoded !== null
        && "analysisKey" in decoded && typeof decoded.analysisKey === "string"
        ? decoded.analysisKey
        : null;
      const evidenceTurnIds = decryptJson<string[]>(fact.evidenceTurnIds);
      const owned = analysisKey !== null && keys.has(analysisKey);
      const legacy = analysisKey === null
        && evidenceTurnIds.length > 0
        && evidenceTurnIds.every((turnId) => legacyEvidence.has(turnId));
      if ((owned || legacy) && fact.source === "ai_inference" && !fact.locked) {
        this.facts.splice(index, 1);
      }
    }
  }
}

class FakeGateway implements ModelGateway {
  readonly requests: StructuredModelRequest<unknown>[] = [];
  readonly embeddedTexts: string[] = [];

  constructor(private readonly responses: unknown[]) {}

  async extract<T>(request: StructuredModelRequest<T>): Promise<T> {
    this.requests.push(request as StructuredModelRequest<unknown>);
    const response = this.responses.shift();
    if (response === undefined) throw new Error("No fake model response queued");
    if (response instanceof Error) throw response;
    return request.schema.parse(response);
  }

  async embed(texts: string[]): Promise<number[][]> {
    this.embeddedTexts.push(...texts);
    return texts.map(() => [0.1, 0.2, 0.3]);
  }
}

type TestChunkPayload = Partial<ChunkMemoryPayload> & {
  previousAnalysisKeys?: string[];
  legacyAnalysisIncomplete?: boolean;
  legacyIncompleteEvidenceTurnIds?: string[];
};

class InMemoryMemoryRepository implements MemoryRepository {
  readonly chunkUpdates: ChunkMemoryUpdate[] = [];
  roomMemory: { roomId: string; encryptedSummary: string } | undefined;
  private readonly latestUpdates = new Map<string, ChunkMemoryUpdate>();
  private readonly roomParticipants: RoomParticipantIdentity[];
  private readonly changedChunkIds = new Set<string>();
  private roomUpsertFailures = 0;

  constructor(
    private readonly chunks: MemoryChunk[],
    roomParticipants?: RoomParticipantIdentity[],
  ) {
    this.roomParticipants = roomParticipants ?? [...new Map(chunks.flatMap((chunk) => (
      chunk.turns.map((turn) => [turn.participantId, { id: turn.participantId, name: turn.participantName }] as const)
    ))).values()];
  }

  async listChunksForAnalysis(roomId: string): Promise<MemoryChunk[]> {
    return this.chunks.filter((chunk) => {
      if (chunk.roomId !== roomId) return false;
      const latest = this.latestUpdates.get(chunk.id);
      if (!latest) return true;
      const decoded = decryptJson<TestChunkPayload | string>(latest.encryptedSummary);
      return this.changedChunkIds.has(chunk.id)
        || typeof decoded === "string"
        || (decoded.analysisPrepared !== true && decoded.analysisComplete !== true);
    }).map((chunk) => {
      const latest = this.latestUpdates.get(chunk.id);
      if (!latest) return chunk;
      const decoded = decryptJson<TestChunkPayload | string>(latest.encryptedSummary);
      if (typeof decoded === "string") {
        return chunk;
      }
      const inheritedLegacy = decoded.legacyAnalysisIncomplete === true
        ? decoded.legacyIncompleteEvidenceTurnIds ?? []
        : [];
      const legacyAnalysisIncomplete = decoded.analysisComplete === false && !decoded.analysisKey;
      return {
        ...chunk,
        previousAnalysisKey: decoded.analysisKey || undefined,
        previousAnalysisKeys: [
          ...(decoded.analysisKey ? [decoded.analysisKey] : []),
          ...(decoded.previousAnalysisKeys ?? []),
        ],
        legacyAnalysisIncomplete: legacyAnalysisIncomplete || inheritedLegacy.length > 0,
        legacyIncompleteEvidenceTurnIds: legacyAnalysisIncomplete
          ? chunk.turns.map((turn) => turn.id)
          : inheritedLegacy,
      } as MemoryChunk;
    });
  }

  async listRoomParticipants(roomId: string): Promise<RoomParticipantIdentity[]> {
    return this.chunks.some((chunk) => chunk.roomId === roomId) ? this.roomParticipants : [];
  }

  async updateChunkMemory(update: ChunkMemoryUpdate): Promise<void> {
    this.chunkUpdates.push(update);
    this.latestUpdates.set(update.chunkId, update);
    const decoded = decryptJson<TestChunkPayload | string>(update.encryptedSummary);
    if (typeof decoded !== "string" && (decoded.analysisPrepared === true || decoded.analysisComplete === true)) {
      this.changedChunkIds.delete(update.chunkId);
    }
  }

  async listChunkMemories(roomId: string): Promise<StoredChunkMemory[]> {
    return this.chunks.filter((chunk) => chunk.roomId === roomId).map((chunk) => {
      const update = this.latestUpdates.get(chunk.id);
      if (!update) return {
        chunkId: chunk.id,
        summary: "",
        emotions: [],
        relationshipSignals: [],
        sourceFingerprint: "",
        analysisKey: "",
        analysisPrepared: false,
        analysisComplete: false,
        candidateProfileFacts: [],
        topicTags: [],
        eventTypes: [],
      };
      return {
        chunkId: chunk.id,
        ...decryptJson<ChunkMemoryPayload>(update.encryptedSummary),
        topicTags: decryptJson<string[]>(update.encryptedTopicTags),
        eventTypes: decryptJson<string[]>(update.encryptedEventTypes),
      };
    });
  }

  async markChunksComplete(roomId: string, chunkIds: string[]): Promise<void> {
    for (const chunkId of chunkIds) {
      const update = this.latestUpdates.get(chunkId);
      if (!update || !this.chunks.some((chunk) => chunk.id === chunkId && chunk.roomId === roomId)) {
        throw new Error("Chunk memory has not been prepared");
      }
      const payload = decryptJson<ChunkMemoryPayload>(update.encryptedSummary);
      await this.updateChunkMemory({
        ...update,
        encryptedSummary: encryptJson<ChunkMemoryPayload>({
          ...payload,
          analysisPrepared: true,
          analysisComplete: true,
        }),
      });
    }
  }

  failNextRoomUpsert(): void {
    this.roomUpsertFailures += 1;
  }

  markChunkChanged(chunkId: string): void {
    this.changedChunkIds.add(chunkId);
  }

  seedChunkMemory(update: ChunkMemoryUpdate): void {
    this.latestUpdates.set(update.chunkId, update);
  }

  async upsertRoomMemory(roomId: string, encryptedSummary: string): Promise<void> {
    if (this.roomUpsertFailures > 0) {
      this.roomUpsertFailures -= 1;
      throw new Error("room memory write unavailable");
    }
    this.roomMemory = { roomId, encryptedSummary };
  }
}

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/private_reply_assistant");
  vi.stubEnv("APP_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
});

afterEach(() => vi.unstubAllEnvs());

test("direct profile edits are encrypted, authoritative, and locked", async () => {
  const repository = new InMemoryProfileRepository();
  const service = new ProfileService(repository);

  const result = await service.applyProfileEdit({
    participantId: "participant-1",
    kind: "speech_pattern",
    value: "친한 사람에게만 반말한다",
    conditions: ["친밀도가 높을 때"],
    exceptions: ["업무 대화"],
    action: "edit",
  });

  expect(result).toMatchObject({ source: "user_edited", confidence: 1, locked: true });
  expect(repository.facts[0]!.encryptedValue).not.toContain("반말");
  expect(decryptJson<string>(repository.facts[0]!.encryptedValue)).toBe("친한 사람에게만 반말한다");
  expect(decryptJson<string[]>(repository.facts[0]!.evidenceTurnIds)).toEqual([]);
});

test("correction chat persists a proposal but changes the profile only after confirmation", async () => {
  const repository = new InMemoryProfileRepository();
  const bootstrap = new ProfileService(repository);
  const original = await bootstrap.applyProfileEdit({
    participantId: "participant-1",
    kind: "personality_tendency",
    value: "장난이 적다",
    conditions: [],
    exceptions: [],
    action: "edit",
  });
  const gateway = new FakeGateway([{
    factKind: "personality_tendency",
    existingFactId: original.id,
    newValue: "친한 사람에게는 장난이 많다",
    conditions: ["친한 사람과 대화할 때"],
    exceptions: ["상대가 진지한 상황"],
  }]);
  const service = new ProfileService(repository, gateway);

  const proposal = await service.proposeProfileCorrection({
    participantId: "participant-1",
    userExplanation: "친한 사람한테는 장난 많이 쳐",
  });

  expect(proposal).toMatchObject({
    oldValue: "장난이 적다",
    newValue: "친한 사람에게는 장난이 많다",
  });
  expect((await service.listProfileFacts("participant-1"))[0]!.value).toBe("장난이 적다");
  expect(repository.revisions[0]!.source).toBe("ai_change_proposal");

  const confirmed = await service.confirmProfileCorrection("participant-1", proposal.proposalId);
  expect(confirmed).toMatchObject({
    value: "친한 사람에게는 장난이 많다",
    source: "user_confirmed",
    confidence: 1,
    locked: true,
  });
  expect(repository.revisions[0]!.source).toBe("user_confirmed");
});

test("hierarchical extraction preserves locked facts, provenance, encryption, and redacted embeddings", async () => {
  const profileRepository = new InMemoryProfileRepository();
  const profileService = new ProfileService(profileRepository);
  await profileService.applyProfileEdit({
    participantId: "participant-1",
    kind: "speech_pattern",
    value: "장난이 적다",
    conditions: [],
    exceptions: [],
    action: "edit",
  });
  const memoryRepository = new InMemoryMemoryRepository([{
    id: "chunk-1",
    roomId: "room-1",
    startedAt: new Date("2026-08-07T00:00:00Z"),
    endedAt: new Date("2026-08-07T00:05:00Z"),
    turns: [{
      id: "turn-1",
      participantId: "participant-1",
      participantName: "민수",
      messages: [{ kind: "text", text: "민수는 오늘도 농담을 많이 했다" }],
    }],
  }]);
  const gateway = new FakeGateway([{
    topicTags: ["농담"],
    eventTypes: ["daily_chat"],
    emotions: ["즐거움"],
    relationshipSignals: ["친밀한 장난"],
    summary: "서로 농담을 주고받았다",
    candidateProfileFacts: [{
      participantId: "participant-1",
      targetFactId: "fact-1",
      kind: "speech_pattern",
      value: "장난이 많다",
      conditions: ["편한 대화"],
      exceptions: [],
      confidence: 0.92,
      evidenceTurnIds: ["turn-1"],
    }, {
      participantId: "participant-1",
      targetFactId: null,
      kind: "interest",
      value: "농담을 즐긴다",
      conditions: [],
      exceptions: [],
      confidence: 0.75,
      evidenceTurnIds: ["turn-1"],
    }],
  }, {
    topics: [{
      key: "playful-daily-chat",
      tags: ["농담"],
      childChunkIds: ["chunk-1"],
      summary: "일상에서 친밀하게 농담을 주고받는다",
    }],
  }, { summary: "친밀한 분위기에서 농담을 주고받는 방" }]);

  const result = await extractRoomMemory("room-1", {
    repository: memoryRepository,
    profileRepository,
    gateway,
  });

  expect(result.updatedChunkIds).toEqual(["chunk-1"]);
  expect(result.proposedFacts).toEqual(expect.arrayContaining([
    expect.objectContaining({ source: "ai_change_proposal", confidence: 0.92, evidenceTurnIds: ["turn-1"] }),
    expect.objectContaining({ source: "ai_inference", confidence: 0.75, evidenceTurnIds: ["turn-1"] }),
  ]));
  expect((await profileService.listProfileFacts("participant-1"))
    .find((fact) => fact.kind === "speech_pattern")).toMatchObject({ value: "장난이 적다", locked: true });
  expect(profileRepository.revisions.some((revision) => (
    revision.source === "ai_change_proposal"
    && !revision.encryptedNextValue.includes("장난이 많다")
  ))).toBe(true);
  const inferredInterest = profileRepository.facts.find((fact) => fact.kind === "interest")!;
  expect(decryptJson<string[]>(inferredInterest.evidenceTurnIds)).toEqual(["turn-1"]);

  expect(gateway.requests.every((request) => request.purpose === "analysis")).toBe(true);
  expect(gateway.embeddedTexts[0]).toContain("participant:participant-1");
  expect(gateway.embeddedTexts[0]).not.toContain("민수");
  const initialChunkPayload = decryptJson<ChunkMemoryPayload>(memoryRepository.chunkUpdates[0]!.encryptedSummary);
  expect(initialChunkPayload.analysisComplete).toBe(false);
  const chunkPayload = decryptJson<ChunkMemoryPayload>(memoryRepository.chunkUpdates.at(-1)!.encryptedSummary);
  expect(chunkPayload).toMatchObject({
    summary: "서로 농담을 주고받았다",
    emotions: ["즐거움"],
    relationshipSignals: ["친밀한 장난"],
    sourceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    analysisKey: expect.stringMatching(/^[a-f0-9]{64}$/),
    analysisPrepared: true,
    analysisComplete: true,
  });
  expect(decryptJson<RoomMemoryPayload>(memoryRepository.roomMemory!.encryptedSummary)).toEqual({
    version: 1,
    topics: [{
      key: "playful-daily-chat",
      tags: ["농담"],
      childChunkIds: ["chunk-1"],
      summary: "일상에서 친밀하게 농담을 주고받는다",
    }],
    summary: "친밀한 분위기에서 농담을 주고받는 방",
  });
  const chunkRequest = JSON.parse(gateway.requests.find((request) => (
    request.schemaName === "conversation_chunk_memory"
  ))!.input) as { existingProfileFacts: Array<{ id: string; kind: string; value: string }> };
  expect(chunkRequest.existingProfileFacts).toContainEqual({
    id: "fact-1",
    participantId: "participant-1",
    kind: "speech_pattern",
    value: "장난이 적다",
  });
  const roomRequest = JSON.parse(gateway.requests.find((request) => (
    request.schemaName === "room_memory"
  ))!.input) as Record<string, unknown>;
  expect(roomRequest).toHaveProperty("topicMemories");
  expect(roomRequest).not.toHaveProperty("childMemories");
});

test("checkpoints prepared chunks and resumes only unfinished model work", async () => {
  const chunk = (index: number): MemoryChunk => ({
    id: `chunk-${index}`,
    roomId: "room-resume",
    startedAt: new Date(`2026-08-07T00:0${index}:00Z`),
    endedAt: new Date(`2026-08-07T00:0${index}:30Z`),
    turns: [{
      id: `turn-${index}`,
      participantId: "participant-1",
      participantName: "민수",
      messages: [{ kind: "text", text: `대화 ${index}` }],
    }],
  });
  const analysis = (index: number) => ({
    topicTags: ["일상"],
    eventTypes: ["daily_chat"],
    emotions: [],
    relationshipSignals: [],
    summary: `요약 ${index}`,
    candidateProfileFacts: [],
  });
  const memoryRepository = new InMemoryMemoryRepository([chunk(1), chunk(2), chunk(3)]);
  const gateway = new FakeGateway([
    analysis(1),
    new ModelResponseValidationError(),
    analysis(2),
    analysis(3),
    { topics: [{
      key: "daily",
      tags: ["일상"],
      childChunkIds: ["chunk-1", "chunk-2", "chunk-3"],
      summary: "일상 대화",
    }] },
    { summary: "일상 대화를 나누는 방" },
  ]);
  const dependencies = {
    repository: memoryRepository,
    profileRepository: new InMemoryProfileRepository(),
    gateway,
  };
  const firstProgress: number[] = [];

  await expect(extractRoomMemory("room-resume", dependencies, async (completed) => {
    firstProgress.push(completed);
  })).rejects.toBeInstanceOf(ModelResponseValidationError);

  expect(firstProgress).toEqual([1]);
  expect(memoryRepository.chunkUpdates).toHaveLength(1);
  expect(decryptJson<ChunkMemoryPayload>(memoryRepository.chunkUpdates[0]!.encryptedSummary))
    .toMatchObject({ analysisPrepared: true, analysisComplete: false });

  const retryProgress: number[] = [];
  await expect(extractRoomMemory("room-resume", dependencies, async (completed) => {
    retryProgress.push(completed);
  })).resolves.toMatchObject({ roomId: "room-resume" });

  expect(retryProgress).toEqual([2, 3]);
  const chunkRequests = gateway.requests.filter((request) => request.schemaName === "conversation_chunk_memory");
  expect(chunkRequests.map((request) => JSON.parse(request.input).chunkId)).toEqual([
    "chunk-1", "chunk-2", "chunk-2", "chunk-3",
  ]);
  expect(gateway.embeddedTexts).toHaveLength(3);
});

test("AI facts without evidence or bounded confidence are rejected", async () => {
  const repository = new InMemoryProfileRepository();
  const service = new ProfileService(repository);

  await expect(service.applyAiInference({
    analysisKey: "bounds-analysis",
    participantId: "participant-1",
    targetFactId: null,
    kind: "interest",
    value: "영화",
    conditions: [],
    exceptions: [],
    confidence: 1.1,
    evidenceTurnIds: ["turn-1"],
  })).rejects.toThrow("between 0 and 1");
  await expect(service.applyAiInference({
    analysisKey: "bounds-analysis",
    participantId: "participant-1",
    targetFactId: null,
    kind: "interest",
    value: "영화",
    conditions: [],
    exceptions: [],
    confidence: 0.8,
    evidenceTurnIds: [],
  })).rejects.toThrow("require evidence");
  expect(repository.facts).toHaveLength(0);
});

test("untargeted same-kind inferences remain additive while invalid targets are rejected", async () => {
  const repository = new InMemoryProfileRepository();
  const service = new ProfileService(repository);
  const evidence = ["turn-1"];

  const movie = await service.applyAiInference({
    analysisKey: "additive-movie",
    participantId: "participant-1",
    targetFactId: null,
    kind: "interest",
    value: "영화를 좋아한다",
    conditions: [],
    exceptions: [],
    confidence: 0.8,
    evidenceTurnIds: evidence,
  });
  const music = await service.applyAiInference({
    analysisKey: "additive-music",
    participantId: "participant-1",
    targetFactId: null,
    kind: "interest",
    value: "라이브 음악을 좋아한다",
    conditions: [],
    exceptions: [],
    confidence: 0.7,
    evidenceTurnIds: evidence,
  });
  await service.applyAiInference({
    analysisKey: "additive-friday-movie",
    participantId: "participant-1",
    targetFactId: null,
    kind: "repeated_event",
    value: "금요일마다 영화를 본다",
    conditions: [],
    exceptions: [],
    confidence: 0.76,
    evidenceTurnIds: evidence,
  });
  await service.applyAiInference({
    analysisKey: "additive-monthly-exhibit",
    participantId: "participant-1",
    targetFactId: null,
    kind: "repeated_event",
    value: "월말에 전시를 간다",
    conditions: [],
    exceptions: [],
    confidence: 0.68,
    evidenceTurnIds: evidence,
  });

  expect(movie.id).not.toBe(music.id);
  expect((await service.listProfileFacts("participant-1")).map((fact) => [fact.kind, fact.value]))
    .toEqual(expect.arrayContaining([
      ["interest", "영화를 좋아한다"],
      ["interest", "라이브 음악을 좋아한다"],
      ["repeated_event", "금요일마다 영화를 본다"],
      ["repeated_event", "월말에 전시를 간다"],
    ]));

  const otherParticipant = await service.applyProfileEdit({
    participantId: "participant-2",
    kind: "interest",
    value: "등산",
    conditions: [],
    exceptions: [],
    action: "edit",
  });
  await expect(service.applyAiInference({
    analysisKey: "invalid-cross-participant",
    participantId: "participant-1",
    targetFactId: otherParticipant.id,
    kind: "interest",
    value: "등산을 좋아한다",
    conditions: [],
    exceptions: [],
    confidence: 0.8,
    evidenceTurnIds: evidence,
  })).rejects.toThrow("same participant and fact kind");
  await expect(service.applyAiInference({
    analysisKey: "invalid-cross-kind",
    participantId: "participant-1",
    targetFactId: movie.id,
    kind: "repeated_event",
    value: "영화를 자주 본다",
    conditions: [],
    exceptions: [],
    confidence: 0.8,
    evidenceTurnIds: evidence,
  })).rejects.toThrow("same participant and fact kind");
});

test("a targeted contradiction to a locked fact becomes a proposal", async () => {
  const repository = new InMemoryProfileRepository();
  const service = new ProfileService(repository);
  const locked = await service.applyProfileEdit({
    participantId: "participant-1",
    kind: "interest",
    value: "공포 영화를 싫어한다",
    conditions: [],
    exceptions: [],
    action: "edit",
  });

  const result = await service.applyAiInference({
    analysisKey: "locked-contradiction",
    participantId: "participant-1",
    targetFactId: locked.id,
    kind: "interest",
    value: "공포 영화를 좋아한다",
    conditions: [],
    exceptions: [],
    confidence: 0.95,
    evidenceTurnIds: ["turn-2"],
  });

  expect(result).toMatchObject({ source: "ai_change_proposal", value: "공포 영화를 좋아한다" });
  expect((await service.listProfileFacts("participant-1"))[0]).toMatchObject({
    id: locked.id,
    value: "공포 영화를 싫어한다",
    locked: true,
  });
});

test("room-wide redaction covers non-speakers and duplicate display names deterministically", () => {
  const chunk: MemoryChunk = {
    id: "chunk-1",
    roomId: "room-1",
    startedAt: new Date("2026-08-07T00:00:00Z"),
    endedAt: new Date("2026-08-07T00:01:00Z"),
    turns: [{
      id: "turn-1",
      participantId: "p1",
      participantName: "지훈",
      messages: [{ kind: "text", text: "민수와 수빈에게 민 얘기도 전해줘" }],
    }],
  };
  const redacted = redactChunkForEmbedding(chunk, [
    { id: "p1", name: "지훈" },
    { id: "p3", name: "민수" },
    { id: "p2", name: "민수" },
    { id: "p4", name: "수빈" },
    { id: "p5", name: "민" },
  ]);

  expect(redacted).toContain("[participants:p2|p3]");
  expect(redacted).toContain("[participant:p4]");
  expect(redacted).toContain("[participant:p5]");
  expect(redacted).not.toMatch(/민수|수빈|민 얘기/);
});

test("an incomplete extraction retries idempotently and repairs facts and room memory", async () => {
  const chunk: MemoryChunk = {
    id: "chunk-retry",
    roomId: "room-retry",
    startedAt: new Date("2026-08-07T00:00:00Z"),
    endedAt: new Date("2026-08-07T00:02:00Z"),
    turns: [{
      id: "turn-retry",
      participantId: "participant-1",
      participantName: "민수",
      messages: [{ kind: "text", text: "민수는 영화 얘기를 자주 한다" }],
    }],
  };
  const chunkAnalysis = {
    topicTags: ["영화"],
    eventTypes: ["daily_chat"],
    emotions: ["흥미"],
    relationshipSignals: [],
    summary: "영화 이야기를 나눴다",
    candidateProfileFacts: [{
      participantId: "participant-1",
      targetFactId: null,
      kind: "interest",
      value: "영화를 좋아한다",
      conditions: [],
      exceptions: [],
      confidence: 0.82,
      evidenceTurnIds: ["turn-retry"],
    }],
  };
  const topicAnalysis = {
    topics: [{
      key: "movies",
      tags: ["영화"],
      childChunkIds: ["chunk-retry"],
      summary: "영화 관심사를 반복해서 이야기한다",
    }],
  };
  const memoryRepository = new InMemoryMemoryRepository([chunk]);
  const profileRepository = new InMemoryProfileRepository();
  const gateway = new FakeGateway([
    chunkAnalysis,
    topicAnalysis,
    new Error("room summary unavailable"),
    topicAnalysis,
    { summary: "영화 이야기가 자주 등장하는 친근한 방" },
  ]);
  const dependencies = { repository: memoryRepository, profileRepository, gateway };

  await expect(extractRoomMemory("room-retry", dependencies)).rejects.toThrow("room summary unavailable");
  expect(profileRepository.facts).toHaveLength(0);
  expect(profileRepository.revisions).toHaveLength(0);
  expect(memoryRepository.roomMemory).toBeUndefined();
  expect(decryptJson<ChunkMemoryPayload>(memoryRepository.chunkUpdates.at(-1)!.encryptedSummary)
    .analysisComplete).toBe(false);

  await expect(extractRoomMemory("room-retry", dependencies)).resolves.toMatchObject({
    roomId: "room-retry",
    updatedChunkIds: ["chunk-retry"],
  });
  expect(profileRepository.facts).toHaveLength(1);
  expect((await new ProfileService(profileRepository).listProfileFacts("participant-1")))
    .toEqual([expect.objectContaining({ kind: "interest", value: "영화를 좋아한다" })]);
  expect(decryptJson<ChunkMemoryPayload>(memoryRepository.chunkUpdates.at(-1)!.encryptedSummary)
    .analysisComplete).toBe(true);
  expect(decryptJson<RoomMemoryPayload>(memoryRepository.roomMemory!.encryptedSummary)).toMatchObject({
    version: 1,
    topics: [expect.objectContaining({ key: "movies", childChunkIds: ["chunk-retry"] })],
    summary: "영화 이야기가 자주 등장하는 친근한 방",
  });
});

test("retry replaces a stale locked-fact proposal from the same chunk analysis", async () => {
  const profileRepository = new InMemoryProfileRepository();
  const profileService = new ProfileService(profileRepository);
  const locked = await profileService.applyProfileEdit({
    participantId: "participant-1",
    kind: "speech_pattern",
    value: "장난이 적다",
    conditions: [],
    exceptions: [],
    action: "edit",
  });
  const chunk: MemoryChunk = {
    id: "chunk-locked-retry",
    roomId: "room-locked-retry",
    startedAt: new Date("2026-08-07T00:00:00Z"),
    endedAt: new Date("2026-08-07T00:02:00Z"),
    turns: [{
      id: "turn-locked-retry",
      participantId: "participant-1",
      participantName: "민수",
      messages: [{ kind: "text", text: "민수는 오늘 장난을 많이 했다" }],
    }],
  };
  const chunkAnalysis = {
    topicTags: ["농담"],
    eventTypes: ["daily_chat"],
    emotions: ["즐거움"],
    relationshipSignals: ["친밀함"],
    summary: "장난을 주고받았다",
    candidateProfileFacts: [{
      participantId: "participant-1",
      targetFactId: locked.id,
      kind: "speech_pattern",
      value: "장난이 많다",
      conditions: [],
      exceptions: [],
      confidence: 0.91,
      evidenceTurnIds: ["turn-locked-retry"],
    }],
  };
  const topics = {
    topics: [{
      key: "jokes",
      tags: ["농담"],
      childChunkIds: ["chunk-locked-retry"],
      summary: "농담을 주고받는 대화",
    }],
  };
  const memoryRepository = new InMemoryMemoryRepository([chunk]);
  memoryRepository.failNextRoomUpsert();
  const gateway = new FakeGateway([
    chunkAnalysis,
    topics,
    { summary: "농담이 자주 등장하는 방" },
    topics,
    { summary: "농담이 자주 등장하는 방" },
  ]);
  const dependencies = { repository: memoryRepository, profileRepository, gateway };

  await expect(extractRoomMemory("room-locked-retry", dependencies))
    .rejects.toThrow("room memory write unavailable");
  expect(profileRepository.revisions.filter((revision) => (
    revision.source === "ai_change_proposal"
  ))).toHaveLength(1);

  await expect(extractRoomMemory("room-locked-retry", dependencies)).resolves.toBeDefined();
  expect(profileRepository.revisions.filter((revision) => (
    revision.source === "ai_change_proposal"
  ))).toHaveLength(1);
  expect((await profileService.listProfileFacts("participant-1"))[0]).toMatchObject({
    id: locked.id,
    value: "장난이 적다",
    locked: true,
    source: "user_edited",
  });
});

test("retry replays checkpointed output without rerunning the chunk model", async () => {
  const profileRepository = new InMemoryProfileRepository();
  const profileService = new ProfileService(profileRepository);
  const unrelated = await profileService.applyAiInference({
    analysisKey: "unrelated-analysis",
    participantId: "participant-1",
    targetFactId: null,
    kind: "interest",
    value: "독서를 좋아한다",
    conditions: [],
    exceptions: [],
    confidence: 0.8,
    evidenceTurnIds: ["unrelated-turn"],
  });
  const locked = await profileService.applyProfileEdit({
    participantId: "participant-1",
    kind: "sensitive_topic",
    value: "가족 이야기는 피한다",
    conditions: [],
    exceptions: [],
    action: "edit",
  });
  const chunk: MemoryChunk = {
    id: "chunk-divergent",
    roomId: "room-divergent",
    startedAt: new Date("2026-08-07T00:00:00Z"),
    endedAt: new Date("2026-08-07T00:02:00Z"),
    turns: [{
      id: "turn-divergent",
      participantId: "participant-1",
      participantName: "민수",
      messages: [{ kind: "text", text: "민수는 주말 취미 이야기를 했다" }],
    }],
  };
  const analysis = (value: string) => ({
    topicTags: ["취미"],
    eventTypes: ["daily_chat"],
    emotions: ["흥미"],
    relationshipSignals: [],
    summary: "주말 취미를 이야기했다",
    candidateProfileFacts: [{
      participantId: "participant-1",
      targetFactId: null,
      kind: "interest",
      value,
      conditions: [],
      exceptions: [],
      confidence: 0.77,
      evidenceTurnIds: ["turn-divergent"],
    }],
  });
  const topics = {
    topics: [{
      key: "hobbies",
      tags: ["취미"],
      childChunkIds: ["chunk-divergent"],
      summary: "취미를 공유한다",
    }],
  };
  const memoryRepository = new InMemoryMemoryRepository([chunk]);
  memoryRepository.failNextRoomUpsert();
  const gateway = new FakeGateway([
    analysis("등산을 좋아한다"),
    topics,
    { summary: "취미를 공유하는 방" },
    topics,
    { summary: "취미를 공유하는 방" },
  ]);
  const dependencies = { repository: memoryRepository, profileRepository, gateway };

  await expect(extractRoomMemory("room-divergent", dependencies))
    .rejects.toThrow("room memory write unavailable");
  expect((await profileService.listProfileFacts("participant-1")).map((fact) => fact.value))
    .toContain("등산을 좋아한다");

  await expect(extractRoomMemory("room-divergent", dependencies)).resolves.toBeDefined();
  const facts = await profileService.listProfileFacts("participant-1");
  expect(facts.map((fact) => fact.value)).toEqual(expect.arrayContaining([
    "독서를 좋아한다",
    "가족 이야기는 피한다",
    "등산을 좋아한다",
  ]));
  expect(facts.map((fact) => fact.value)).not.toContain("사진 촬영을 좋아한다");
  expect(facts.filter((fact) => fact.kind === "interest")).toHaveLength(2);
  expect(facts).toContainEqual(expect.objectContaining({ id: unrelated.id }));
  expect(facts).toContainEqual(expect.objectContaining({ id: locked.id, locked: true }));
});

test("changed chunk fingerprint removes the prior locked-fact proposal", async () => {
  const profileRepository = new InMemoryProfileRepository();
  const profileService = new ProfileService(profileRepository);
  const locked = await profileService.applyProfileEdit({
    participantId: "participant-1",
    kind: "speech_pattern",
    value: "장난이 적다",
    conditions: [],
    exceptions: [],
    action: "edit",
  });
  const chunk: MemoryChunk = {
    id: "chunk-changed-proposal",
    roomId: "room-changed-proposal",
    startedAt: new Date("2026-08-07T00:00:00Z"),
    endedAt: new Date("2026-08-07T00:02:00Z"),
    turns: [{
      id: "turn-changed-proposal",
      participantId: "participant-1",
      participantName: "민수",
      messages: [{ kind: "text", text: "민수는 오늘 장난을 많이 했다" }],
    }],
  };
  const analysis = (candidateProfileFacts: unknown[]) => ({
    topicTags: ["농담"],
    eventTypes: ["daily_chat"],
    emotions: ["즐거움"],
    relationshipSignals: [],
    summary: "장난에 관해 대화했다",
    candidateProfileFacts,
  });
  const contradiction = {
    participantId: "participant-1",
    targetFactId: locked.id,
    kind: "speech_pattern",
    value: "장난이 많다",
    conditions: [],
    exceptions: [],
    confidence: 0.9,
    evidenceTurnIds: ["turn-changed-proposal"],
  };
  const topics = { topics: [{
    key: "jokes",
    tags: ["농담"],
    childChunkIds: ["chunk-changed-proposal"],
    summary: "농담 관련 대화",
  }] };
  const memoryRepository = new InMemoryMemoryRepository([chunk]);
  const gateway = new FakeGateway([
    analysis([contradiction]), topics, { summary: "농담을 나누는 방" },
    analysis([]), topics, { summary: "농담 기록이 수정된 방" },
  ]);
  const dependencies = { repository: memoryRepository, profileRepository, gateway };

  await extractRoomMemory(chunk.roomId, dependencies);
  expect(profileRepository.revisions.filter((revision) => revision.source === "ai_change_proposal"))
    .toHaveLength(1);

  chunk.turns[0]!.messages[0]!.text = "민수는 오늘 장난을 하지 않았다고 정정했다";
  memoryRepository.markChunkChanged(chunk.id);
  await extractRoomMemory(chunk.roomId, dependencies);

  expect(profileRepository.revisions.filter((revision) => revision.source === "ai_change_proposal"))
    .toHaveLength(0);
  expect((await profileService.listProfileFacts("participant-1"))).toContainEqual(expect.objectContaining({
    id: locked.id,
    value: "장난이 적다",
    locked: true,
  }));
});

test("changed chunk fingerprint replaces divergent additive output from its prior key", async () => {
  const chunk: MemoryChunk = {
    id: "chunk-changed-fact",
    roomId: "room-changed-fact",
    startedAt: new Date("2026-08-07T00:00:00Z"),
    endedAt: new Date("2026-08-07T00:02:00Z"),
    turns: [{
      id: "turn-changed-fact",
      participantId: "participant-1",
      participantName: "민수",
      messages: [{ kind: "text", text: "민수는 등산을 좋아한다" }],
    }],
  };
  const analysis = (value: string) => ({
    topicTags: ["취미"],
    eventTypes: ["daily_chat"],
    emotions: ["흥미"],
    relationshipSignals: [],
    summary: "취미를 이야기했다",
    candidateProfileFacts: [{
      participantId: "participant-1",
      targetFactId: null,
      kind: "interest",
      value,
      conditions: [],
      exceptions: [],
      confidence: 0.8,
      evidenceTurnIds: ["turn-changed-fact"],
    }],
  });
  const topics = { topics: [{
    key: "hobbies",
    tags: ["취미"],
    childChunkIds: [chunk.id],
    summary: "취미 관련 대화",
  }] };
  const memoryRepository = new InMemoryMemoryRepository([chunk]);
  const profileRepository = new InMemoryProfileRepository();
  const gateway = new FakeGateway([
    analysis("등산을 좋아한다"), topics, { summary: "취미를 공유하는 방" },
    analysis("사진 촬영을 좋아한다"), topics, new Error("changed room summary unavailable"),
    topics, { summary: "취미 기록이 수정된 방" },
  ]);
  const dependencies = { repository: memoryRepository, profileRepository, gateway };

  await extractRoomMemory(chunk.roomId, dependencies);
  chunk.turns[0]!.messages[0]!.text = "민수는 사진 촬영을 좋아한다고 정정했다";
  memoryRepository.markChunkChanged(chunk.id);
  await expect(extractRoomMemory(chunk.roomId, dependencies))
    .rejects.toThrow("changed room summary unavailable");
  await extractRoomMemory(chunk.roomId, dependencies);

  const values = (await new ProfileService(profileRepository).listProfileFacts("participant-1"))
    .map((fact) => fact.value);
  expect(values).toContain("사진 촬영을 좋아한다");
  expect(values).not.toContain("등산을 좋아한다");
});

test("legacy incomplete replay cleans only unowned AI artifacts evidenced by that chunk", async () => {
  const incompleteChunk: MemoryChunk = {
    id: "chunk-legacy-incomplete",
    roomId: "room-legacy",
    startedAt: new Date("2026-08-07T00:00:00Z"),
    endedAt: new Date("2026-08-07T00:01:00Z"),
    turns: [{
      id: "turn-legacy-incomplete",
      participantId: "participant-1",
      participantName: "민수",
      messages: [{ kind: "text", text: "민수의 이전 분석" }],
    }],
  };
  const completeChunk: MemoryChunk = {
    id: "chunk-legacy-complete",
    roomId: "room-legacy",
    startedAt: new Date("2026-08-07T00:02:00Z"),
    endedAt: new Date("2026-08-07T00:03:00Z"),
    turns: [{
      id: "turn-legacy-complete",
      participantId: "participant-1",
      participantName: "민수",
      messages: [{ kind: "text", text: "민수의 완료된 이전 분석" }],
    }],
  };
  const memoryRepository = new InMemoryMemoryRepository([incompleteChunk, completeChunk]);
  const seed = (chunk: MemoryChunk, analysisComplete: boolean) => memoryRepository.seedChunkMemory({
    roomId: chunk.roomId,
    chunkId: chunk.id,
    encryptedSummary: encryptJson({
      summary: "legacy",
      emotions: [],
      relationshipSignals: [],
      sourceFingerprint: "legacy-fingerprint",
      analysisComplete,
    }),
    encryptedTopicTags: encryptJson([]),
    encryptedEventTypes: encryptJson([]),
    embedding: [0.1],
  });
  seed(incompleteChunk, false);
  seed(completeChunk, true);
  memoryRepository.markChunkChanged(completeChunk.id);

  const profileRepository = new InMemoryProfileRepository();
  const legacyFact = async (value: string, evidenceTurnId: string, locked = false) => (
    profileRepository.createFact({
      participantId: "participant-1",
      kind: "interest",
      encryptedValue: encryptJson(value),
      encryptedConditions: encryptJson([]),
      encryptedExceptions: encryptJson([]),
      evidenceTurnIds: encryptJson([evidenceTurnId]),
      confidence: 0.6,
      source: "ai_inference",
      locked,
    })
  );
  const staleIncomplete = await legacyFact("불완전 분석 산책", "turn-legacy-incomplete");
  const complete = await legacyFact("완료 분석 독서", "turn-legacy-complete");
  const locked = await legacyFact("잠긴 사용자 보존", "turn-legacy-incomplete", true);
  const owned = await new ProfileService(profileRepository).applyAiInference({
    analysisKey: "unrelated-owned-analysis",
    participantId: "participant-1",
    targetFactId: null,
    kind: "interest",
    value: "소유된 분석 보존",
    conditions: [],
    exceptions: [],
    confidence: 0.7,
    evidenceTurnIds: ["turn-legacy-incomplete"],
  });
  const staleProposal = await profileRepository.createRevision({
    profileFactId: locked.id,
    encryptedPreviousValue: locked.encryptedValue,
    encryptedNextValue: encryptJson({
      value: "불완전 제안",
      evidenceTurnIds: ["turn-legacy-incomplete"],
    }),
    encryptedConditions: encryptJson([]),
    encryptedExceptions: encryptJson([]),
    source: "ai_change_proposal",
  });
  const completeProposal = await profileRepository.createRevision({
    profileFactId: locked.id,
    encryptedPreviousValue: locked.encryptedValue,
    encryptedNextValue: encryptJson({
      value: "완료 제안",
      evidenceTurnIds: ["turn-legacy-complete"],
    }),
    encryptedConditions: encryptJson([]),
    encryptedExceptions: encryptJson([]),
    source: "ai_change_proposal",
  });
  const ownedProposal = await profileRepository.createRevision({
    profileFactId: locked.id,
    encryptedPreviousValue: locked.encryptedValue,
    encryptedNextValue: encryptJson({
      version: 1,
      value: "소유된 제안",
      evidenceTurnIds: ["turn-legacy-incomplete"],
      analysisKey: "unrelated-owned-analysis",
    }),
    encryptedConditions: encryptJson([]),
    encryptedExceptions: encryptJson([]),
    source: "ai_change_proposal",
  });
  const emptyAnalysis = {
    topicTags: [], eventTypes: [], emotions: [], relationshipSignals: [],
    summary: "재분석", candidateProfileFacts: [],
  };
  const gateway = new FakeGateway([
    emptyAnalysis,
    emptyAnalysis,
    { topics: [{ key: "legacy", tags: [], childChunkIds: [incompleteChunk.id, completeChunk.id], summary: "재분석" }] },
    { summary: "레거시 재분석 완료" },
  ]);

  await extractRoomMemory("room-legacy", {
    repository: memoryRepository,
    profileRepository,
    gateway,
  });

  expect(profileRepository.facts.map((fact) => fact.id)).not.toContain(staleIncomplete.id);
  expect(profileRepository.facts.map((fact) => fact.id)).toEqual(expect.arrayContaining([
    complete.id,
    locked.id,
    owned.id,
  ]));
  expect(profileRepository.revisions.map((revision) => revision.id)).not.toContain(staleProposal.id);
  expect(profileRepository.revisions.map((revision) => revision.id)).toEqual(expect.arrayContaining([
    completeProposal.id,
    ownedProposal.id,
  ]));
});

test("profile replacement rolls back cleanup and partial replay on a later targeted error", async () => {
  const repository = new InMemoryProfileRepository();
  const service = new ProfileService(repository);
  await service.applyAiInference({
    analysisKey: "rollback-analysis",
    participantId: "participant-1",
    targetFactId: null,
    kind: "interest",
    value: "원래 분석",
    conditions: [],
    exceptions: [],
    confidence: 0.7,
    evidenceTurnIds: ["turn-rollback"],
  });
  const beforeFacts = repository.facts.map((fact) => ({ ...fact }));
  const beforeRevisions = repository.revisions.map((revision) => ({ ...revision }));

  await expect(service.replaceAiAnalysis(["rollback-analysis"], [{
    analysisKey: "rollback-analysis",
    participantId: "participant-1",
    targetFactId: null,
    kind: "interest",
    value: "부분 재생",
    conditions: [],
    exceptions: [],
    confidence: 0.8,
    evidenceTurnIds: ["turn-rollback"],
  }, {
    analysisKey: "rollback-analysis",
    participantId: "participant-1",
    targetFactId: "missing-target",
    kind: "interest",
    value: "실패 대상",
    conditions: [],
    exceptions: [],
    confidence: 0.8,
    evidenceTurnIds: ["turn-rollback"],
  }])).rejects.toThrow("same participant and fact kind");

  expect(repository.facts).toEqual(beforeFacts);
  expect(repository.revisions).toEqual(beforeRevisions);
});

test("legacy encrypted string fact and revision values remain readable", async () => {
  const repository = new InMemoryProfileRepository();
  const legacy = await repository.createFact({
    participantId: "participant-legacy",
    kind: "interest",
    encryptedValue: encryptJson("오래된 문자열 값"),
    encryptedConditions: encryptJson([]),
    encryptedExceptions: encryptJson([]),
    evidenceTurnIds: encryptJson(["legacy-turn"]),
    confidence: 0.6,
    source: "ai_inference",
    locked: false,
  });
  const revision = await repository.createRevision({
    profileFactId: legacy.id,
    encryptedPreviousValue: legacy.encryptedValue,
    encryptedNextValue: encryptJson("교정된 문자열 값"),
    encryptedConditions: encryptJson([]),
    encryptedExceptions: encryptJson([]),
    source: "ai_change_proposal",
  });
  const service = new ProfileService(repository);

  expect((await service.listProfileFacts("participant-legacy"))[0]).toMatchObject({
    value: "오래된 문자열 값",
    evidenceTurnIds: ["legacy-turn"],
  });
  await expect(service.confirmProfileCorrection("participant-legacy", revision.id)).resolves.toMatchObject({
    value: "교정된 문자열 값",
    source: "user_confirmed",
    locked: true,
  });
});

test("profile API routes require an authenticated session before reading profiles", async () => {
  const request = new Request("https://assistant.test/api/profiles/participant-1");

  await expect(getProfileRoute(request, {
    params: Promise.resolve({ participantId: "participant-1" }),
  })).resolves.toMatchObject({ status: 401 });
});
