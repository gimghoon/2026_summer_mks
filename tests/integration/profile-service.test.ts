import type { StructuredModelRequest, ModelGateway } from "@/domain/models/gateway";
import { decryptJson } from "@/domain/crypto/encrypted-json";
import {
  extractRoomMemory,
  type ChunkMemoryPayload,
  type ChunkMemoryUpdate,
  type MemoryChunk,
  type MemoryRepository,
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

  async transaction<T>(work: (repository: ProfileRepository) => Promise<T>): Promise<T> {
    return work(this);
  }

  async listFacts(participantId: string): Promise<StoredProfileFact[]> {
    return this.facts.filter((fact) => fact.participantId === participantId);
  }

  async findFact(factId: string): Promise<StoredProfileFact | undefined> {
    return this.facts.find((fact) => fact.id === factId);
  }

  async createFact(fact: Omit<StoredProfileFact, "id">): Promise<StoredProfileFact> {
    const created = { ...fact, id: `fact-${this.facts.length + 1}` };
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
    const created = { ...revision, id: `revision-${this.revisions.length + 1}` };
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
}

class FakeGateway implements ModelGateway {
  readonly requests: StructuredModelRequest<unknown>[] = [];
  readonly embeddedTexts: string[] = [];

  constructor(private readonly responses: unknown[]) {}

  async extract<T>(request: StructuredModelRequest<T>): Promise<T> {
    this.requests.push(request as StructuredModelRequest<unknown>);
    const response = this.responses.shift();
    if (response === undefined) throw new Error("No fake model response queued");
    return request.schema.parse(response);
  }

  async embed(texts: string[]): Promise<number[][]> {
    this.embeddedTexts.push(...texts);
    return texts.map(() => [0.1, 0.2, 0.3]);
  }
}

class InMemoryMemoryRepository implements MemoryRepository {
  readonly chunkUpdates: ChunkMemoryUpdate[] = [];
  roomMemory: { roomId: string; encryptedSummary: string } | undefined;

  constructor(private readonly pendingChunks: MemoryChunk[]) {}

  async listChunksForAnalysis(roomId: string): Promise<MemoryChunk[]> {
    return this.pendingChunks.filter((chunk) => chunk.roomId === roomId);
  }

  async updateChunkMemory(update: ChunkMemoryUpdate): Promise<void> {
    this.chunkUpdates.push(update);
  }

  async upsertRoomMemory(roomId: string, encryptedSummary: string): Promise<void> {
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
      kind: "speech_pattern",
      value: "장난이 많다",
      conditions: ["편한 대화"],
      exceptions: [],
      confidence: 0.92,
      evidenceTurnIds: ["turn-1"],
    }, {
      participantId: "participant-1",
      kind: "interest",
      value: "농담을 즐긴다",
      conditions: [],
      exceptions: [],
      confidence: 0.75,
      evidenceTurnIds: ["turn-1"],
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
  const chunkPayload = decryptJson<ChunkMemoryPayload>(memoryRepository.chunkUpdates[0]!.encryptedSummary);
  expect(chunkPayload).toEqual({
    summary: "서로 농담을 주고받았다",
    emotions: ["즐거움"],
    relationshipSignals: ["친밀한 장난"],
    sourceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(decryptJson<string>(memoryRepository.roomMemory!.encryptedSummary))
    .toBe("친밀한 분위기에서 농담을 주고받는 방");
});

test("AI facts without evidence or bounded confidence are rejected", async () => {
  const repository = new InMemoryProfileRepository();
  const service = new ProfileService(repository);

  await expect(service.applyAiInference({
    participantId: "participant-1",
    kind: "interest",
    value: "영화",
    conditions: [],
    exceptions: [],
    confidence: 1.1,
    evidenceTurnIds: ["turn-1"],
  })).rejects.toThrow("between 0 and 1");
  await expect(service.applyAiInference({
    participantId: "participant-1",
    kind: "interest",
    value: "영화",
    conditions: [],
    exceptions: [],
    confidence: 0.8,
    evidenceTurnIds: [],
  })).rejects.toThrow("require evidence");
  expect(repository.facts).toHaveLength(0);
});

test("profile API routes require an authenticated session before reading profiles", async () => {
  const request = new Request("https://assistant.test/api/profiles/participant-1");

  await expect(getProfileRoute(request, {
    params: Promise.resolve({ participantId: "participant-1" }),
  })).rejects.toMatchObject({ status: 401 });
});
