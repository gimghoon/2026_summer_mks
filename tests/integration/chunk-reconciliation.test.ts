import { decryptJson, encryptJson } from "@/domain/crypto/encrypted-json";
import {
  chunksCoverTurnsExactlyOnce,
  reconcileRoomChunks,
  type ChunkPartitionWrite,
  type ChunkReconciliationRepository,
  type StoredChunkPartition,
} from "@/domain/memory/chunk-reconciliation";

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/private_reply_assistant");
  vi.stubEnv("APP_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  vi.stubEnv("SESSION_SIGNING_KEY", Buffer.alloc(32, 13).toString("base64"));
});

afterEach(() => vi.unstubAllEnvs());

class MemoryChunks implements ChunkReconciliationRepository {
  chunks: StoredChunkPartition[] = [];
  private nextId = 1;

  async listChunks() { return this.chunks.map((chunk) => ({ ...chunk })); }
  async insertChunk(_roomId: string, chunk: ChunkPartitionWrite) {
    this.chunks.push({ id: `chunk-${this.nextId++}`, ...chunk });
  }
  async updateChunk(_roomId: string, chunkId: string, chunk: ChunkPartitionWrite) {
    const index = this.chunks.findIndex((stored) => stored.id === chunkId);
    if (index < 0) throw new Error("missing chunk");
    this.chunks[index] = { id: chunkId, ...chunk };
  }
  async deleteChunks(_roomId: string, chunkIds: string[]) {
    this.chunks = this.chunks.filter((chunk) => !chunkIds.includes(chunk.id));
  }
}

function turn(id: string, minute: number) {
  const at = new Date(`2026-08-07T00:${String(minute).padStart(2, "0")}:00.000Z`);
  return { id, startedAt: at, endedAt: at };
}

test("incremental reanalysis covers appended turns once without duplicate chunks", async () => {
  const repository = new MemoryChunks();
  const initialTurns = [turn("turn-1", 0), turn("turn-2", 1)];
  await reconcileRoomChunks("room-1", initialTurns, repository);
  repository.chunks[0]!.encryptedSummary = encryptJson({
    summary: "old",
    sourceFingerprint: "old-fingerprint",
    analysisKey: "analysis-old",
    analysisComplete: true,
  });
  const stableChunkId = repository.chunks[0]!.id;

  const appendedTurns = [...initialTurns, turn("turn-3", 40), turn("turn-4", 41)];
  await reconcileRoomChunks("room-1", appendedTurns, repository);
  await reconcileRoomChunks("room-1", appendedTurns, repository);

  expect(repository.chunks).toHaveLength(2);
  expect(new Set(repository.chunks.map((chunk) => chunk.id)).size).toBe(2);
  expect(repository.chunks[0]!.id).toBe(stableChunkId);
  expect(chunksCoverTurnsExactlyOnce(appendedTurns, repository.chunks)).toBe(true);
});

test("appending inside a partition reuses its ID and preserves prior analysis lineage", async () => {
  const repository = new MemoryChunks();
  await reconcileRoomChunks("room-1", [turn("turn-1", 0)], repository);
  const stableChunkId = repository.chunks[0]!.id;
  repository.chunks[0]!.encryptedSummary = encryptJson({
    summary: "old",
    sourceFingerprint: "old-fingerprint",
    analysisKey: "analysis-old",
    analysisComplete: true,
  });

  const turns = [turn("turn-1", 0), turn("turn-2", 1)];
  await reconcileRoomChunks("room-1", turns, repository);

  expect(repository.chunks).toHaveLength(1);
  expect(repository.chunks[0]).toMatchObject({ id: stableChunkId, startTurnId: "turn-1", endTurnId: "turn-2" });
  expect(decryptJson<{ analysisKey: string }>(repository.chunks[0]!.encryptedSummary).analysisKey).toBe("analysis-old");
  expect(chunksCoverTurnsExactlyOnce(turns, [...repository.chunks, repository.chunks[0]!])).toBe(false);
});
