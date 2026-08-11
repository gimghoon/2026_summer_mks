import { fireEvent, render, screen } from "@testing-library/react";
import { ReplyComposer } from "@/components/reply-composer";

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

const replyCandidates = [
  { strategy: "relationship_soft", text: "a", intentLabel: "a", riskLabel: null, contextBasis: [], warnings: [] },
  { strategy: "emotion_signal", text: "b", intentLabel: "b", riskLabel: null, contextBasis: [], warnings: [] },
  { strategy: "clearer_request", text: "c", intentLabel: "c", riskLabel: null, contextBasis: [], warnings: [] },
];

function fillRequiredFields() {
  fireEvent.change(screen.getByLabelText("최근 대화"), { target: { value: "민수: 미안 늦었어" } });
  fireEvent.change(screen.getByLabelText("현재 상황"), { target: { value: "늦어서 서운해" } });
}

test("defaults personal context enforcement off and remembers a changed choice", () => {
  const { unmount } = render(<ReplyComposer roomId="r1" participantId="p1" />);
  const checkbox = screen.getByRole("checkbox", { name: "개인 컨텍스트 강제 반영" });

  expect(checkbox).not.toBeChecked();
  fireEvent.click(checkbox);
  expect(window.localStorage.getItem("reply-required-personal-context")).toBe("true");
  unmount();
  render(<ReplyComposer roomId="r1" participantId="p1" />);
  expect(screen.getByRole("checkbox", { name: "개인 컨텍스트 강제 반영" })).toBeChecked();
});

test("always sends the effective personal context mode", async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ candidates: replyCandidates }) });
  vi.stubGlobal("fetch", fetchMock);
  render(<ReplyComposer roomId="r1" participantId="p1" />);

  fillRequiredFields();
  fireEvent.click(screen.getByRole("button", { name: "답장 3개 만들기" }));
  await screen.findAllByTestId("reply-candidate");
  expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toMatchObject({ personalContextMode: "normal" });
});

test("sends required personal context mode when enforcement is checked", async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ candidates: replyCandidates }) });
  vi.stubGlobal("fetch", fetchMock);
  render(<ReplyComposer roomId="r1" participantId="p1" />);

  fireEvent.click(screen.getByRole("checkbox", { name: "개인 컨텍스트 강제 반영" }));
  fillRequiredFields();
  fireEvent.click(screen.getByRole("button", { name: "답장 3개 만들기" }));
  await screen.findAllByTestId("reply-candidate");
  expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toMatchObject({ personalContextMode: "required" });
});

test("shows a profile recovery action when required personal context is unavailable", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: false,
    status: 409,
    json: async () => ({
      kind: "personal_context_unavailable",
      message: "사용할 개인 컨텍스트가 없어요. 프로필을 먼저 확인하거나 직접 추가해 주세요.",
    }),
  }));
  render(<ReplyComposer roomId="r1" participantId="p1" />);

  fillRequiredFields();
  fireEvent.click(screen.getByRole("button", { name: "답장 3개 만들기" }));
  expect(await screen.findByText("사용할 개인 컨텍스트가 없어요. 프로필을 먼저 확인하거나 직접 추가해 주세요.")).toBeVisible();
  expect(screen.getByRole("link", { name: "프로필 확인하기" })).toHaveAttribute("href", "/rooms/r1/profiles/p1");
  expect(screen.getByLabelText("최근 대화")).toHaveValue("민수: 미안 늦었어");
  expect(screen.getByLabelText("현재 상황")).toHaveValue("늦어서 서운해");
});

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
    { strategy: "relationship_soft", text: "응 알겠어", intentLabel: "부드럽게", riskLabel: null, contextBasis: [], warnings: [] },
    { strategy: "emotion_signal", text: "음 그렇구나", intentLabel: "감정 신호", riskLabel: "눈치가 없을 수 있음", contextBasis: [], warnings: [] },
    { strategy: "clearer_request", text: "다음엔 말해줘", intentLabel: "요청", riskLabel: null, contextBasis: [], warnings: [] },
  ] }) }));
  render(<ReplyComposer roomId="r1" participantId="p1" />);
  fireEvent.change(screen.getByLabelText("최근 대화"), { target: { value: "민수: 미안 늦었어" } });
  fireEvent.change(screen.getByLabelText("현재 상황"), { target: { value: "늦어서 서운해" } });
  fireEvent.click(screen.getByRole("button", { name: "답장 3개 만들기" }));
  expect(await screen.findAllByTestId("reply-candidate")).toHaveLength(3);
});

test("sends the selected relationship as a per-request generation rule", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ candidates: [
    { strategy: "relationship_soft", text: "a", intentLabel: "a", riskLabel: null, contextBasis: [], warnings: [] }, { strategy: "emotion_signal", text: "b", intentLabel: "b", riskLabel: null, contextBasis: [], warnings: [] }, { strategy: "clearer_request", text: "c", intentLabel: "c", riskLabel: null, contextBasis: [], warnings: [] },
  ] }) }));
  render(<ReplyComposer roomId="r1" participantId="p1" initialRelationship="girlfriend" />);
  fireEvent.change(screen.getByLabelText("최근 대화"), { target: { value: "대화" } }); fireEvent.change(screen.getByLabelText("현재 상황"), { target: { value: "상황" } }); fireEvent.click(screen.getByRole("button", { name: "답장 3개 만들기" }));
  await screen.findAllByTestId("reply-candidate");
  expect(fetch).toHaveBeenCalledWith("/api/replies", expect.objectContaining({ body: expect.stringContaining('"relationship":"girlfriend"') }));
});

test("sends the saved browser intensity even without a one-request override", async () => {
  window.localStorage.setItem("reply-default-indirectness", "4");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ candidates: [
    { strategy: "relationship_soft", text: "a", intentLabel: "a", riskLabel: null, contextBasis: [], warnings: [] }, { strategy: "emotion_signal", text: "b", intentLabel: "b", riskLabel: null, contextBasis: [], warnings: [] }, { strategy: "clearer_request", text: "c", intentLabel: "c", riskLabel: null, contextBasis: [], warnings: [] },
  ] }) }));
  render(<ReplyComposer roomId="r1" participantId="p1" />);
  fireEvent.change(screen.getByLabelText("최근 대화"), { target: { value: "대화" } }); fireEvent.change(screen.getByLabelText("현재 상황"), { target: { value: "상황" } }); fireEvent.click(screen.getByRole("button", { name: "답장 3개 만들기" }));
  await screen.findAllByTestId("reply-candidate");
  expect(fetch).toHaveBeenCalledWith("/api/replies", expect.objectContaining({ body: expect.stringContaining('"indirectness":4') }));
});

test("allows a one-request creative intensity of seven", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ candidates: [
    { strategy: "relationship_soft", text: "a", intentLabel: "a", riskLabel: null, contextBasis: [], warnings: [] }, { strategy: "emotion_signal", text: "b", intentLabel: "b", riskLabel: null, contextBasis: [], warnings: [] }, { strategy: "clearer_request", text: "c", intentLabel: "c", riskLabel: null, contextBasis: [], warnings: [] },
  ] }) }));
  render(<ReplyComposer roomId="r1" participantId="p1" />);
  const slider = screen.getByRole("slider", { name: "여자어 강도" });

  expect(slider).toHaveAttribute("max", "7");
  fireEvent.click(screen.getByLabelText("이번 답장만 강도 변경"));
  fireEvent.change(slider, { target: { value: "7" } });
  fireEvent.change(screen.getByLabelText("최근 대화"), { target: { value: "민수: 또 늦었어" } });
  fireEvent.change(screen.getByLabelText("현재 상황"), { target: { value: "기다려서 서운해" } });
  fireEvent.click(screen.getByRole("button", { name: "답장 3개 만들기" }));

  await screen.findAllByTestId("reply-candidate");
  expect(fetch).toHaveBeenCalledWith("/api/replies", expect.objectContaining({
    body: expect.stringContaining('"indirectness":7'),
  }));
});

test("loads a saved creative intensity of seven", () => {
  window.localStorage.setItem("reply-default-indirectness", "7");
  render(<ReplyComposer roomId="r1" participantId="p1" />);

  expect(screen.getByRole("slider", { name: "여자어 강도" })).toHaveValue("7");
});
