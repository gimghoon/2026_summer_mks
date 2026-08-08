import { fireEvent, render, screen } from "@testing-library/react";
import { ReplyComposer } from "@/components/reply-composer";

test("uses saved indirectness and allows a one-request override", () => {
  render(<ReplyComposer roomId="r1" participantId="p1" defaultIndirectness={3} />);
  const slider = screen.getByRole("slider", { name: "여자어 강도" });
  expect(slider).toHaveValue("3");
  expect(slider).toBeDisabled();
  fireEvent.click(screen.getByLabelText("이번 답장만 강도 변경"));
  fireEvent.change(slider, { target: { value: "4" } });
  expect(slider).toHaveValue("4");
  expect(screen.getByText("기본 설정은 3단계로 유지됩니다.")).toBeVisible();
});

test("renders exactly three returned reply cards", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ candidates: [
    { strategy: "relationship_soft", text: "응 알겠어", intentLabel: "부드럽게", riskLabel: null },
    { strategy: "emotion_signal", text: "음 그렇구나", intentLabel: "감정 신호", riskLabel: "눈치가 없을 수 있음" },
    { strategy: "clearer_request", text: "다음엔 말해줘", intentLabel: "요청", riskLabel: null },
  ] }) }));
  render(<ReplyComposer roomId="r1" participantId="p1" />);
  fireEvent.change(screen.getByLabelText("최근 대화"), { target: { value: "민수: 미안 늦었어" } });
  fireEvent.change(screen.getByLabelText("현재 상황"), { target: { value: "늦어서 서운해" } });
  fireEvent.click(screen.getByRole("button", { name: "답장 3개 만들기" }));
  expect(await screen.findAllByTestId("reply-candidate")).toHaveLength(3);
  vi.unstubAllGlobals();
});
