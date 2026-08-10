import { createAnalysisProgressRepository, type AnalysisProgress } from "@/domain/memory/analysis-progress";
import {
  runRoomAnalysis,
  withRoomAnalysisLock,
  type RoomAnalysisOperations,
} from "@/domain/memory/room-analysis-orchestrator";
import { ModelResponseValidationError } from "@/domain/models/gateway";

function progressHarness() {
  let current: AnalysisProgress | null = null;
  return {
    repository: createAnalysisProgressRepository({
      get: async () => current,
      put: async (progress) => { current = progress; },
    }),
    get: () => current,
  };
}

test("persists chunk progress and logs only scalar failure metadata", async () => {
  const progress = progressHarness();
  const log = vi.fn();
  const operations: RoomAnalysisOperations = {
    progress: progress.repository,
    log,
    reconcile: async () => 3,
    prepare: async (onPrepared) => {
      await onPrepared(1);
      throw new ModelResponseValidationError();
    },
    plan: vi.fn(),
    apply: vi.fn(),
  };

  await expect(runRoomAnalysis("room-1", operations)).rejects.toBeInstanceOf(ModelResponseValidationError);

  expect(progress.get()).toMatchObject({
    status: "failed",
    stage: "chunks",
    completedChunks: 1,
    totalChunks: 3,
    failure: "model_validation",
  });
  expect(log).toHaveBeenCalledWith("room_analysis_failed", {
    roomId: "room-1",
    stage: "chunks",
    completedChunks: 1,
    totalChunks: 3,
    failure: "model_validation",
    providerStatus: 0,
  });
  expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE_CONVERSATION");
});

test("moves through hierarchy and profile stages before becoming ready", async () => {
  const progress = progressHarness();
  const stages: string[] = [];
  const originalFinalizing = progress.repository.finalizing;
  progress.repository.finalizing = async (roomId, stage) => {
    stages.push(stage);
    await originalFinalizing(roomId, stage);
  };
  const result = { roomId: "room-1", updatedChunkIds: ["chunk-1"], proposedFacts: [] };

  await expect(runRoomAnalysis("room-1", {
    progress: progress.repository,
    log: vi.fn(),
    reconcile: async () => 1,
    prepare: async (onPrepared) => { await onPrepared(1); },
    plan: async () => ({ prepared: true }),
    apply: async () => result,
  })).resolves.toEqual(result);

  expect(stages).toEqual(["hierarchy", "profiles"]);
  expect(progress.get()).toMatchObject({ status: "ready", stage: "complete", completedChunks: 1 });
});

test("keeps overlapping room jobs outside the lock until the first releases", async () => {
  let executeCalls = 0;
  let releaseSecondLock!: () => void;
  const secondLock = new Promise<void>((resolve) => { releaseSecondLock = resolve; });
  const database = {
    execute: vi.fn(async () => {
      executeCalls += 1;
      if (executeCalls === 2) await secondLock;
      if (executeCalls === 3) releaseSecondLock();
      return [];
    }),
  };
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstWork = new Promise<void>((resolve) => { releaseFirst = resolve; });

  const first = withRoomAnalysisLock(database as never, "room-1", async () => {
    events.push("first-enter");
    await firstWork;
    events.push("first-exit");
  });
  await vi.waitFor(() => expect(events).toEqual(["first-enter"]));
  const second = withRoomAnalysisLock(database as never, "room-1", async () => {
    events.push("second-enter");
  });
  await Promise.resolve();
  expect(events).toEqual(["first-enter"]);
  releaseFirst();
  await Promise.all([first, second]);

  expect(events).toEqual(["first-enter", "first-exit", "second-enter"]);
  expect(database.execute).toHaveBeenCalledTimes(4);
});
