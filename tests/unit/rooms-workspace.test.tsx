import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RoomsWorkspace } from "@/components/rooms-workspace";

const pushMock = vi.hoisted(() => vi.fn());
const refreshMock = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock, refresh: refreshMock }), usePathname: () => "/rooms" }));

beforeEach(() => {
  sessionStorage.clear();
  pushMock.mockReset();
  refreshMock.mockReset();
});

test("shows unparsed import lines before analysis can continue", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ roomId: "room-1", unparsedLines: [{ line: 9, text: "형식을 확인해 주세요" }] }) }));
  render(<RoomsWorkspace initialRooms={[]} />);
  const file = new File(["대화"], "kakao.txt", { type: "text/plain" });
  fireEvent.change(screen.getByLabelText("카카오톡 파일 업로드"), { target: { files: [file] } });
  fireEvent.change(screen.getByLabelText("내 이름"), { target: { value: "나" } });
  fireEvent.click(screen.getByRole("button", { name: "파일 가져오기" }));
  expect(await screen.findByText("확인할 줄 1개")).toBeVisible();
  fireEvent.click(screen.getByText("확인할 줄 1개"));
  expect(screen.getByText("형식을 확인해 주세요")).toBeVisible();
  expect(screen.getByRole("button", { name: "검토 후 분석 시작" })).toBeEnabled();
  expect(screen.getByText("파일 가져오기가 끝났어요")).toBeVisible();
  expect(screen.queryByText("45%")).not.toBeInTheDocument();
  vi.unstubAllGlobals();
});

test("starts analysis and navigates to the shared room progress screen", async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ roomId: "room-1", unparsedLines: [] }) })
    .mockResolvedValueOnce({ ok: true });
  vi.stubGlobal("fetch", fetchMock);
  render(<RoomsWorkspace initialRooms={[]} />);
  fireEvent.change(screen.getByLabelText("카카오톡 파일 업로드"), {
    target: { files: [new File(["대화"], "kakao.txt", { type: "text/plain" })] },
  });
  fireEvent.change(screen.getByLabelText("내 이름"), { target: { value: "나" } });
  fireEvent.click(screen.getByRole("button", { name: "파일 가져오기" }));
  fireEvent.click(await screen.findByRole("button", { name: "검토 후 분석 시작" }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    "/api/rooms/room-1/analysis",
    { method: "POST" },
  ));
  expect(pushMock).toHaveBeenCalledWith("/rooms/room-1");
  expect(screen.queryByText("65%")).not.toBeInTheDocument();
  vi.unstubAllGlobals();
});

test("submits an additional upload to the selected existing room", async () => {
  const roomId = "11111111-1111-4111-8111-111111111111";
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ roomId, unparsedLines: [] }) });
  vi.stubGlobal("fetch", fetchMock);
  render(<RoomsWorkspace initialRooms={[{
    id: roomId,
    title: "민수와 대화",
    updatedAt: "2026-08-07T00:00:00.000Z",
    analysisStatus: "ready",
    participants: [],
  }]} />);
  fireEvent.change(screen.getByLabelText("가져올 대화방"), { target: { value: roomId } });
  fireEvent.change(screen.getByLabelText("카카오톡 파일 업로드"), {
    target: { files: [new File(["대화"], "more.txt", { type: "text/plain" })] },
  });
  fireEvent.change(screen.getByLabelText("내 이름"), { target: { value: "나" } });
  fireEvent.click(screen.getByRole("button", { name: "파일 가져오기" }));

  await screen.findByRole("button", { name: "검토 후 분석 시작" });
  const body = fetchMock.mock.calls[0]![1].body as FormData;
  expect(body.get("existingRoomId")).toBe(roomId);
  vi.unstubAllGlobals();
});
