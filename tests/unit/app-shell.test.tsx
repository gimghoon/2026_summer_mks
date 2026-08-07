import { render, screen } from "@testing-library/react";
import HomePage from "@/app/page";

test("shows the private assistant entry point", () => {
  render(<HomePage />);
  expect(screen.getByRole("heading", { name: "내 카카오톡 답장 도우미" })).toBeVisible();
  expect(screen.getByRole("link", { name: "대화방 열기" })).toHaveAttribute("href", "/rooms");
});
