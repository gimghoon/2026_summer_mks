import { act, fireEvent, render, screen } from "@testing-library/react";
import { ReplyResults } from "@/components/reply-results";

const candidates = [
  { strategy: "relationship_soft" as const, text: "처음 문장", intentLabel: "관계", riskLabel: null },
  { strategy: "emotion_signal" as const, text: "둘째", intentLabel: "감정", riskLabel: null },
  { strategy: "clearer_request" as const, text: "셋째", intentLabel: "요청", riskLabel: null },
];

test("keeps a completed edit and copies the edited candidate", async () => {
  const writeText = vi.fn(async () => {}); Object.assign(navigator, { clipboard: { writeText } });
  render(<ReplyResults candidates={candidates} />);
  fireEvent.click(screen.getAllByRole("button", { name: "수정" })[0]!);
  fireEvent.change(screen.getByLabelText("부드럽게 관계 지키기 답장 수정"), { target: { value: "바꾼 문장" } });
  fireEvent.click(screen.getByRole("button", { name: "수정 완료" }));
  expect(screen.getByText("바꾼 문장")).toBeVisible();
  await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "복사" })[0]!); });
  await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("바꾼 문장"));
  await vi.waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("답장을 복사했어요"));
});

test("reports when clipboard access is unavailable", () => {
  Object.assign(navigator, { clipboard: undefined });
  render(<ReplyResults candidates={candidates} />);
  fireEvent.click(screen.getAllByRole("button", { name: "복사" })[0]!);
  expect(screen.getByRole("status")).toHaveTextContent("자동 복사를 지원하지 않아요");
});
