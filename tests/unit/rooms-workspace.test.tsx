import { fireEvent, render, screen } from "@testing-library/react";
import { RoomsWorkspace } from "@/components/rooms-workspace";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/rooms" }));

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
  vi.unstubAllGlobals();
});
