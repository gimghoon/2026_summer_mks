import { ModelResponseValidationError } from "@/domain/models/gateway";
import {
  classifyAnalysisFailure,
  createAnalysisProgressRepository,
  type AnalysisProgress,
  type AnalysisProgressStore,
} from "@/domain/memory/analysis-progress";

class InMemoryProgressStore implements AnalysisProgressStore {
  rows = new Map<string, AnalysisProgress>();

  async get(roomId: string) {
    return this.rows.get(roomId) ?? null;
  }

  async put(progress: AnalysisProgress) {
    this.rows.set(progress.roomId, { ...progress });
  }
}

const roomId = "11111111-1111-4111-8111-111111111111";

test("persists scalar progress and clears a failed run on retry", async () => {
  const repository = createAnalysisProgressRepository(new InMemoryProgressStore());

  await repository.start(roomId, 3);
  await repository.recordChunk(roomId, 1);
  await repository.failed(roomId, "model_validation");
  expect(await repository.get(roomId)).toMatchObject({
    status: "failed",
    stage: "chunks",
    completedChunks: 1,
    totalChunks: 3,
    failure: "model_validation",
  });

  await repository.start(roomId, 3);
  expect(await repository.get(roomId)).toMatchObject({
    status: "analyzing",
    stage: "chunks",
    completedChunks: 1,
    totalChunks: 3,
    failure: "none",
  });
});

test("clamps stale completed counts when a retry has fewer current chunks", async () => {
  const repository = createAnalysisProgressRepository(new InMemoryProgressStore());
  await repository.start(roomId, 5);
  await repository.recordChunk(roomId, 4);

  await repository.start(roomId, 2);

  expect(await repository.get(roomId)).toMatchObject({ completedChunks: 2, totalChunks: 2 });
});

test("moves through hierarchy, profiles, and ready states", async () => {
  const repository = createAnalysisProgressRepository(new InMemoryProgressStore());
  await repository.start(roomId, 2);
  await repository.recordChunk(roomId, 2);
  await repository.finalizing(roomId, "hierarchy");
  expect(await repository.get(roomId)).toMatchObject({ status: "finalizing", stage: "hierarchy" });
  await repository.finalizing(roomId, "profiles");
  expect(await repository.get(roomId)).toMatchObject({ status: "finalizing", stage: "profiles" });
  await repository.ready(roomId);
  expect(await repository.get(roomId)).toMatchObject({
    status: "ready", stage: "complete", completedChunks: 2, totalChunks: 2, failure: "none",
  });
});

test("classifies failures without returning exception messages", () => {
  expect(classifyAnalysisFailure(Object.assign(new Error("PRIVATE"), { status: 429 })))
    .toBe("provider_unavailable");
  expect(classifyAnalysisFailure(Object.assign(new Error("PRIVATE"), { status: 400 })))
    .toBe("provider_rejected");
  expect(classifyAnalysisFailure(new ModelResponseValidationError()))
    .toBe("model_validation");
  expect(classifyAnalysisFailure(Object.assign(new Error("PRIVATE"), { code: "23505" })))
    .toBe("database");
  expect(classifyAnalysisFailure(new Error("PRIVATE_CONVERSATION"))).toBe("unexpected");
});
