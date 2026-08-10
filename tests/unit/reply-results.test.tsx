import { act, fireEvent, render, screen } from "@testing-library/react";
import { ReplyResults } from "@/components/reply-results";
import type { ReplyCandidate } from "@/domain/replies/reply-service";

const candidates: ReplyCandidate[] = [
  {
    strategy: "relationship_soft" as const,
    text: "처음 문장",
    intentLabel: "관계",
    riskLabel: null,
    contextBasis: ["말투: 짧은 문장을 자주 사용함"],
    warnings: ["emotional_inference", "personal_style_mismatch"],
  },
  { strategy: "emotion_signal" as const, text: "둘째", intentLabel: "감정", riskLabel: null, contextBasis: [], warnings: [] },
  { strategy: "clearer_request" as const, text: "셋째", intentLabel: "요청", riskLabel: null, contextBasis: [], warnings: [] },
];

test("renders verified context basis and advisory warnings", () => {
  render(<ReplyResults candidates={candidates} />);

  expect(screen.getByText("퍼스널 컨텍스트 근거")).toBeVisible();
  expect(screen.getByText("말투: 짧은 문장을 자주 사용함")).toBeVisible();
  expect(screen.getByText("감정 해석 포함")).toBeVisible();
  expect(screen.getByText("평소 말투와 다를 수 있음")).toBeVisible();
  expect(screen.getByText(/보내기 전에 실제 의도와 맞는지 확인/)).toBeVisible();
});

test("limits context basis and deduplicates warning badges", () => {
  render(<ReplyResults candidates={[{
    ...candidates[0],
    contextBasis: ["근거 하나", "근거 둘", "근거 셋"],
    warnings: ["duplicate_text", "duplicate_text", "profile_conflict"],
  }]} />);

  expect(screen.getByText("근거 하나")).toBeVisible();
  expect(screen.getByText("근거 둘")).toBeVisible();
  expect(screen.queryByText("근거 셋")).not.toBeInTheDocument();
  expect(screen.getAllByText("답장 간 표현 유사")).toHaveLength(1);
  expect(screen.getByText("프로필과 다를 수 있음")).toBeVisible();
});

test("keeps a completed edit and copies the edited candidate", async () => {
  const writeText = vi.fn(async () => {}); Object.assign(navigator, { clipboard: { writeText } });
  render(<ReplyResults candidates={candidates} />);
  fireEvent.click(screen.getAllByRole("button", { name: "수정" })[0]!);
  fireEvent.change(screen.getByLabelText("부드럽게 관계 지키기 답장 수정"), { target: { value: "바꾼 문장" } });
  fireEvent.click(screen.getByRole("button", { name: "수정 완료" }));
  expect(screen.getByText("바꾼 문장")).toBeVisible();
  await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "복사" })[0]!); });
  await vi.waitFor(() => {
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("바꾼 문장");
  });
  expect(writeText).not.toHaveBeenCalledWith(expect.stringContaining("말투: 짧은 문장을 자주 사용함"));
  expect(writeText).not.toHaveBeenCalledWith(expect.stringContaining("감정 해석 포함"));
  await vi.waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("답장을 복사했어요"));
});

test("reports when clipboard access is unavailable", () => {
  Object.assign(navigator, { clipboard: undefined });
  render(<ReplyResults candidates={candidates} />);
  fireEvent.click(screen.getAllByRole("button", { name: "복사" })[0]!);
  expect(screen.getByRole("status")).toHaveTextContent("자동 복사를 지원하지 않아요");
});
