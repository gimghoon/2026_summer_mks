// @vitest-environment node

const sessionFailureMock = vi.hoisted(() => vi.fn());
const getRoomViewMock = vi.hoisted(() => vi.fn());
const getProgressMock = vi.hoisted(() => vi.fn());

vi.mock("@/domain/auth/session", () => ({ apiSessionFailure: sessionFailureMock }));
vi.mock("@/domain/rooms/room-read-service", () => ({ getRoomView: getRoomViewMock }));
vi.mock("@/domain/memory/room-analysis-orchestrator", () => ({
  analyzeImportedRoom: vi.fn(),
  getRoomAnalysisProgress: getProgressMock,
}));
vi.mock("@/domain/testing/e2e-fixture-store", () => ({
  fixtureModeEnabled: () => false,
  analyzeFixtureRoom: vi.fn(),
}));
vi.mock("@/db/client", () => ({ getDb: vi.fn() }));

import { GET } from "@/app/api/rooms/[roomId]/analysis/route";

const context = { params: Promise.resolve({ roomId: "11111111-1111-4111-8111-111111111111" }) };

beforeEach(() => {
  sessionFailureMock.mockReset();
  getRoomViewMock.mockReset();
  getProgressMock.mockReset();
});

test("authenticates before looking up analysis progress", async () => {
  sessionFailureMock.mockResolvedValue(new Response("Unauthorized", { status: 401 }));

  const response = await GET(new Request("https://assistant.test/api/rooms/id/analysis"), context);

  expect(response.status).toBe(401);
  expect(getRoomViewMock).not.toHaveBeenCalled();
  expect(getProgressMock).not.toHaveBeenCalled();
});

test("returns only scalar persisted progress for an existing room", async () => {
  sessionFailureMock.mockResolvedValue(null);
  getRoomViewMock.mockResolvedValue({ id: "room", analysisStatus: "needs_analysis" });
  getProgressMock.mockResolvedValue({
    roomId: "11111111-1111-4111-8111-111111111111",
    status: "analyzing",
    stage: "chunks",
    completedChunks: 17,
    totalChunks: 50,
    failure: "none",
  });

  const response = await GET(new Request("https://assistant.test/api/rooms/id/analysis"), context);

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    roomId: "11111111-1111-4111-8111-111111111111",
    status: "analyzing",
    stage: "chunks",
    completedChunks: 17,
    totalChunks: 50,
    failure: "none",
  });
});

test("returns 404 without reading progress for an unknown room", async () => {
  sessionFailureMock.mockResolvedValue(null);
  getRoomViewMock.mockResolvedValue(null);

  const response = await GET(new Request("https://assistant.test/api/rooms/id/analysis"), context);

  expect(response.status).toBe(404);
  expect(getProgressMock).not.toHaveBeenCalled();
});
