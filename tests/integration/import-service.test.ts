import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { decryptJson } from "@/domain/crypto/encrypted-json";
import {
  importKakaoExport,
  type ImportRepository,
  type StoredMessage,
  type TurnToPersist,
} from "@/domain/imports/import-service";
import {
  chunksCoverTurnsExactlyOnce,
  reconcileRoomChunks,
  type ChunkPartitionWrite,
  type ChunkReconciliationRepository,
  type StoredChunkPartition,
} from "@/domain/memory/chunk-reconciliation";

function fixture(name: string): string {
  return readFileSync(resolve(process.cwd(), "tests/fixtures/kakao", name), "utf8");
}

class InMemoryImportRepository implements ImportRepository {
  private roomId: string | undefined;
  private participants = new Map<string, string>();
  readonly messages: StoredMessage[] = [];
  readonly persistedTurns: TurnToPersist[] = [];

  async transaction<T>(work: (repository: ImportRepository) => Promise<T>): Promise<T> {
    return work(this);
  }

  async resolveRoom(input: { encryptedTitle: string; existingRoomId?: string }): Promise<string> {
    if (input.existingRoomId) return input.existingRoomId;
    this.roomId ??= "room-1";
    return this.roomId;
  }

  async resolveParticipants(
    _roomId: string,
    entries: Array<{ name: string; encryptedName: string; isSelf: boolean }>,
  ): Promise<Map<string, string>> {
    for (const entry of entries) this.participants.set(entry.name, this.participants.get(entry.name) ?? `person-${this.participants.size + 1}`);
    return new Map(this.participants);
  }

  async insertMessage(input: Parameters<ImportRepository["insertMessage"]>[0]) {
    if (this.messages.some((message) => message.sourceFingerprint === input.sourceFingerprint)) {
      return { id: "", inserted: false };
    }
    const id = `message-${this.messages.length + 1}`;
    const speaker = [...this.participants.entries()].find(([, participantId]) => participantId === input.participantId)?.[0];
    if (!speaker) throw new Error("Missing participant");
    this.messages.push({
      id,
      participantId: input.participantId,
      sentAt: input.sentAt,
      kind: input.kind,
      text: decryptJson<string>(input.encryptedText),
      speaker,
      sourceFingerprint: input.sourceFingerprint,
      sourceLine: input.sourceLine,
    });
    return { id, inserted: true };
  }

  async listMessages(): Promise<StoredMessage[]> {
    return [...this.messages];
  }

  async replaceAffectedTurns(
    _roomId: string,
    affectedMessageIds: string[],
    replacementTurns: TurnToPersist[],
  ): Promise<void> {
    const affected = new Set(affectedMessageIds);
    for (let index = this.persistedTurns.length - 1; index >= 0; index -= 1) {
      if (decryptJson<string[]>(this.persistedTurns[index]!.encryptedMessageIds).some((id) => affected.has(id))) {
        this.persistedTurns.splice(index, 1);
      }
    }
    this.persistedTurns.push(...replacementTurns);
  }
}

class ImportedRoomChunks implements ChunkReconciliationRepository {
  chunks: StoredChunkPartition[] = [];
  private nextId = 1;
  async listChunks() { return this.chunks.map((chunk) => ({ ...chunk })); }
  async insertChunk(_roomId: string, chunk: ChunkPartitionWrite) { this.chunks.push({ id: `chunk-${this.nextId++}`, ...chunk }); }
  async updateChunk(_roomId: string, chunkId: string, chunk: ChunkPartitionWrite) {
    const index = this.chunks.findIndex((stored) => stored.id === chunkId);
    this.chunks[index] = { id: chunkId, ...chunk };
  }
  async deleteChunks(_roomId: string, chunkIds: string[]) { this.chunks = this.chunks.filter((chunk) => !chunkIds.includes(chunk.id)); }
}

function importedTurns(repository: InMemoryImportRepository) {
  return repository.persistedTurns.map((turn) => {
    const messageIds = decryptJson<string[]>(turn.encryptedMessageIds);
    return {
      id: `turn-${messageIds[0]}`,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
    };
  }).sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime());
}

const databaseUrl = "postgresql://postgres:postgres@localhost:5432/private_reply_assistant";

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", databaseUrl);
  vi.stubEnv("APP_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  vi.stubEnv("SESSION_SIGNING_KEY", Buffer.alloc(32, 13).toString("base64"));
});

afterEach(() => vi.unstubAllEnvs());

test("imports encrypted messages once when an existing room is re-imported", async () => {
  const repository = new InMemoryImportRepository();
  const command = {
    title: "민수와 카카오톡 대화",
    selfName: "지훈",
    rawText: fixture("one-to-one.txt"),
  };

  const first = await importKakaoExport(command, repository);
  const second = await importKakaoExport({ ...command, existingRoomId: first.roomId }, repository);

  expect(first).toMatchObject({ roomId: "room-1", insertedMessages: 5, duplicateMessages: 0 });
  expect(second).toMatchObject({ roomId: "room-1", insertedMessages: 0, duplicateMessages: 5 });
  expect(repository.messages.map((message) => message.text)).toContain("거의 다 왔어 ㅋㅋ");
  expect(repository.persistedTurns).toHaveLength(3);
  expect(repository.persistedTurns.every((turn) => !turn.encryptedMessageIds.includes("message-"))).toBe(true);
});

test("rejects an unsupported export before opening an import transaction", async () => {
  const repository = new InMemoryImportRepository();
  const transaction = vi.spyOn(repository, "transaction");

  await expect(importKakaoExport({
    title: "지원하지 않는 파일",
    selfName: "지훈",
    rawText: "Date,User,Other\n2026-08-07 09:01:02,민수,안녕",
  }, repository)).rejects.toThrow("No valid KakaoTalk messages");
  expect(transaction).not.toHaveBeenCalled();
});

test("replaces neighboring turns when a late middle message creates new boundaries", async () => {
  const repository = new InMemoryImportRepository();
  const initial = [
    "지훈과 카카오톡 대화",
    "2026년 8월 7일 오전 9:01, 민수 : 먼저 도착했어",
    "2026년 8월 7일 오전 9:03, 민수 : 커피 주문할게",
  ].join("\n");
  const lateMiddle = [
    "지훈과 카카오톡 대화",
    "2026년 8월 7일 오전 9:02, 지훈 : 나도 거의 다 왔어",
  ].join("\n");

  const first = await importKakaoExport({
    title: "지훈과 카카오톡 대화", selfName: "지훈", rawText: initial,
  }, repository);
  await importKakaoExport({
    title: "지훈과 카카오톡 대화", selfName: "지훈", rawText: lateMiddle, existingRoomId: first.roomId,
  }, repository);

  const turnMessageIds = repository.persistedTurns.map((turn) => decryptJson<string[]>(turn.encryptedMessageIds));
  expect(turnMessageIds).toEqual([["message-1"], ["message-3"], ["message-2"]]);
  expect(new Set(turnMessageIds.flat()).size).toBe(3);
});

test("persists legitimate identical same-minute messages and keeps full-export reimport idempotent", async () => {
  const repository = new InMemoryImportRepository();
  const rawText = [
    "민수와 카카오톡 대화",
    "2026년 8월 7일 오전 9:01, 민수 : 응",
    "2026년 8월 7일 오전 9:01, 민수 : 응",
  ].join("\n");
  const first = await importKakaoExport({ title: "민수와 카카오톡 대화", selfName: "지훈", rawText }, repository);
  const second = await importKakaoExport({
    title: "민수와 카카오톡 대화",
    selfName: "지훈",
    rawText,
    existingRoomId: first.roomId,
  }, repository);

  expect(first).toMatchObject({ insertedMessages: 2, duplicateMessages: 0 });
  expect(second).toMatchObject({ insertedMessages: 0, duplicateMessages: 2 });
  expect(repository.messages).toHaveLength(2);
});

test("incremental import followed by reanalysis reuses the changed chunk without duplicates", async () => {
  const imports = new InMemoryImportRepository();
  const analysis = new ImportedRoomChunks();
  const initial = "민수와 카카오톡 대화\n2026년 8월 7일 오전 9:01, 민수 : 먼저 도착했어";
  const first = await importKakaoExport({ title: "민수와 대화", selfName: "지훈", rawText: initial }, imports);
  await reconcileRoomChunks(first.roomId, importedTurns(imports), analysis);
  const stableChunkId = analysis.chunks[0]!.id;

  const additional = "민수와 카카오톡 대화\n2026년 8월 7일 오전 9:02, 민수 : 커피도 주문할게";
  await importKakaoExport({
    title: "민수와 대화",
    selfName: "지훈",
    rawText: additional,
    existingRoomId: first.roomId,
  }, imports);
  const turns = importedTurns(imports);
  await reconcileRoomChunks(first.roomId, turns, analysis);
  await reconcileRoomChunks(first.roomId, turns, analysis);

  expect(analysis.chunks).toHaveLength(1);
  expect(analysis.chunks[0]!.id).toBe(stableChunkId);
  expect(chunksCoverTurnsExactlyOnce(turns, analysis.chunks)).toBe(true);
});
