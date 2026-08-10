import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { getDb } from "@/db/client";
import { roomAnalysisRuns } from "@/db/schema";
import { ModelResponseValidationError } from "@/domain/models/gateway";

export type AnalysisRunStatus = "pending" | "analyzing" | "finalizing" | "ready" | "failed";
export type AnalysisStage = "chunks" | "hierarchy" | "profiles" | "complete";
export type AnalysisFailureCode =
  | "none"
  | "provider_rejected"
  | "provider_unavailable"
  | "model_validation"
  | "evidence_validation"
  | "hierarchy_validation"
  | "database"
  | "unexpected";

export type AnalysisProgress = {
  roomId: string;
  status: AnalysisRunStatus;
  stage: AnalysisStage;
  completedChunks: number;
  totalChunks: number;
  failure: AnalysisFailureCode;
  /** Present for persisted production runs; used only to recover abandoned jobs. */
  updatedAt?: string;
};

export interface AnalysisProgressStore {
  get(roomId: string): Promise<AnalysisProgress | null>;
  put(progress: AnalysisProgress): Promise<void>;
}

export interface AnalysisProgressRepository {
  start(roomId: string, totalChunks: number): Promise<void>;
  recordChunk(roomId: string, completedChunks: number): Promise<void>;
  finalizing(roomId: string, stage: "hierarchy" | "profiles"): Promise<void>;
  ready(roomId: string): Promise<void>;
  failed(roomId: string, failure: AnalysisFailureCode): Promise<void>;
  get(roomId: string): Promise<AnalysisProgress | null>;
}

function checkedCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("Analysis progress counts must be non-negative integers");
  return value;
}

async function requiredProgress(store: AnalysisProgressStore, roomId: string): Promise<AnalysisProgress> {
  const progress = await store.get(roomId);
  if (!progress) throw new Error("Analysis progress has not started");
  return progress;
}

export function createAnalysisProgressRepository(store: AnalysisProgressStore): AnalysisProgressRepository {
  return {
    async start(roomId, totalChunks) {
      const total = checkedCount(totalChunks);
      const previous = await store.get(roomId);
      await store.put({
        roomId,
        status: total === 0 ? "pending" : "analyzing",
        stage: "chunks",
        completedChunks: Math.min(previous?.completedChunks ?? 0, total),
        totalChunks: total,
        failure: "none",
      });
    },
    async recordChunk(roomId, completedChunks) {
      const previous = await requiredProgress(store, roomId);
      const completed = checkedCount(completedChunks);
      if (completed > previous.totalChunks) throw new RangeError("Completed chunks cannot exceed total chunks");
      await store.put({ ...previous, status: "analyzing", stage: "chunks", completedChunks: completed, failure: "none" });
    },
    async finalizing(roomId, stage) {
      const previous = await requiredProgress(store, roomId);
      await store.put({ ...previous, status: "finalizing", stage, failure: "none" });
    },
    async ready(roomId) {
      const previous = await requiredProgress(store, roomId);
      await store.put({
        ...previous,
        status: "ready",
        stage: "complete",
        completedChunks: previous.totalChunks,
        failure: "none",
      });
    },
    async failed(roomId, failure) {
      const previous = await requiredProgress(store, roomId);
      await store.put({ ...previous, status: "failed", failure });
    },
    get: (roomId) => store.get(roomId),
  };
}

type DrizzleExecutor = Pick<NodePgDatabase<typeof import("@/db/schema")>, "select" | "insert">;

export function createDrizzleAnalysisProgressStore(
  database: NodePgDatabase<typeof import("@/db/schema")> = getDb(),
): AnalysisProgressStore {
  const executor = database as DrizzleExecutor;
  return {
    async get(roomId) {
      const rows = await executor.select({
        roomId: roomAnalysisRuns.roomId,
        status: roomAnalysisRuns.status,
        stage: roomAnalysisRuns.stage,
        completedChunks: roomAnalysisRuns.completedChunks,
        totalChunks: roomAnalysisRuns.totalChunks,
        failure: roomAnalysisRuns.failure,
        updatedAt: roomAnalysisRuns.updatedAt,
      }).from(roomAnalysisRuns).where(eq(roomAnalysisRuns.roomId, roomId));
      const row = rows[0];
      if (!row) return null;
      return { ...row, updatedAt: row.updatedAt.toISOString() } as AnalysisProgress;
    },
    async put(progress) {
      const { updatedAt: _updatedAt, ...fields } = progress;
      await executor.insert(roomAnalysisRuns).values(fields).onConflictDoUpdate({
        target: roomAnalysisRuns.roomId,
        set: { ...fields, updatedAt: new Date() },
      });
    },
  };
}

export function createDrizzleAnalysisProgressRepository(
  database: NodePgDatabase<typeof import("@/db/schema")> = getDb(),
): AnalysisProgressRepository {
  return createAnalysisProgressRepository(createDrizzleAnalysisProgressStore(database));
}

function numericProperty(error: unknown, property: "status"): number | undefined {
  if (typeof error !== "object" || error === null || !(property in error)) return undefined;
  const value = error[property];
  return typeof value === "number" ? value : undefined;
}

function stringProperty(error: unknown, property: "code" | "name"): string | undefined {
  if (typeof error !== "object" || error === null || !(property in error)) return undefined;
  const value = (error as Record<string, unknown>)[property];
  return typeof value === "string" ? value : undefined;
}

export function classifyAnalysisFailure(error: unknown): AnalysisFailureCode {
  if (error instanceof ModelResponseValidationError) return "model_validation";
  const status = numericProperty(error, "status");
  if (status === 429 || (status !== undefined && status >= 500)) return "provider_unavailable";
  if (status !== undefined && status >= 400) return "provider_rejected";
  const code = stringProperty(error, "code");
  if (code && /^23/.test(code)) return "database";
  const name = stringProperty(error, "name");
  if (name === "EvidenceValidationError") return "evidence_validation";
  if (name === "HierarchyValidationError") return "hierarchy_validation";
  return "unexpected";
}
