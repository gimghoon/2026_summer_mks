import { act, fireEvent, render, screen } from "@testing-library/react";
import { RoomAnalysisActions } from "@/components/room-analysis-actions";
import type { RoomView } from "@/domain/rooms/room-read-types";

const refreshMock = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: refreshMock }) }));

const room: RoomView = {
  id: "room-1",
  title: "민수와 대화",
  updatedAt: "2026-08-10T00:00:00.000Z",
  participants: [],
  analysisStatus: "needs_analysis",
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

beforeEach(() => refreshMock.mockReset());

test("polls and renders real chunk progress while analysis is pending", async () => {
  vi.useFakeTimers();
  let finishPost!: () => void;
  const post = new Promise<{ ok: boolean }>((resolve) => { finishPost = () => resolve({ ok: true }); });
  const fetchMock = vi.fn((_: string, init?: RequestInit) => {
    if (init?.method === "POST") return post;
    return Promise.resolve({
      ok: true,
      json: async () => ({
        roomId: room.id,
        status: "analyzing",
        stage: "chunks",
        completedChunks: 17,
        totalChunks: 50,
        failure: "none",
      }),
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<RoomAnalysisActions room={room} pollIntervalMs={10} />);

  fireEvent.click(screen.getByRole("button", { name: "분석 다시 시도" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(12); });

  expect(screen.getByText("청크 17/50 분석 완료")).toBeVisible();
  expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "34");
  finishPost();
  await act(async () => { await post; });
  vi.useRealTimers();
});

test("shows persisted finalization and failure states after reload", async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({
      roomId: room.id,
      status: "finalizing",
      stage: "hierarchy",
      completedChunks: 50,
      totalChunks: 50,
      failure: "none",
    }) });
  vi.stubGlobal("fetch", fetchMock);
  const { rerender } = render(<RoomAnalysisActions room={room} />);
  expect(await screen.findByText("대화방 맥락을 종합하는 중이에요")).toBeVisible();

  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({
    roomId: room.id,
    status: "failed",
    stage: "chunks",
    completedChunks: 17,
    totalChunks: 50,
    failure: "provider_unavailable",
  }) });
  rerender(<RoomAnalysisActions room={{ ...room, id: "room-2" }} />);
  expect(await screen.findByText("분석을 마치지 못했어요. 다시 시도해 주세요.")).toBeVisible();
  expect(screen.queryByText("provider_unavailable")).not.toBeInTheDocument();
});

test("refreshes server-rendered room controls when polling reaches ready", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({
    roomId: room.id,
    status: "ready",
    stage: "complete",
    completedChunks: 50,
    totalChunks: 50,
    failure: "none",
  }) }));

  render(<RoomAnalysisActions room={room} />);

  expect(await screen.findByText("분석 완료 · 프로필과 답장을 만들 수 있어요.")).toBeVisible();
  expect(refreshMock).toHaveBeenCalledTimes(1);
});
