import { asc, eq, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import { turns } from "@/db/schema";
import { createDrizzleMemoryRepository, extractRoomMemory } from "./extractor";
import {
  chunksCoverTurnsExactlyOnce,
  createDrizzleChunkReconciliationRepository,
  reconcileRoomChunks,
} from "./chunk-reconciliation";
import { createDrizzleProfileRepository } from "@/domain/profiles/profile-service";
import { OpenAIModelGateway } from "@/domain/models/openai-gateway";

/** Reconciles deterministic chunks, then retries only changed or incomplete extraction work. */
export async function analyzeImportedRoom(roomId: string) {
  const database = getDb();
  return database.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${roomId}))`);
    const storedTurns = await transaction.select({ id: turns.id, startedAt: turns.startedAt, endedAt: turns.endedAt })
      .from(turns).where(eq(turns.roomId, roomId)).orderBy(asc(turns.startedAt), asc(turns.id));
    const chunkRepository = createDrizzleChunkReconciliationRepository(transaction);
    await reconcileRoomChunks(roomId, storedTurns, chunkRepository);
    const reconciled = await chunkRepository.listChunks(roomId);
    if (!chunksCoverTurnsExactlyOnce(storedTurns, reconciled)) {
      throw new Error("Room chunks do not cover every turn exactly once");
    }
    return extractRoomMemory(roomId, {
      repository: createDrizzleMemoryRepository(transaction),
      profileRepository: createDrizzleProfileRepository(transaction),
      gateway: new OpenAIModelGateway(),
    });
  });
}
