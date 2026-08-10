import { fireEvent, render, screen } from "@testing-library/react";

import SettingsPage from "@/app/settings/page";

vi.mock("next/navigation", () => ({ usePathname: () => "/settings" }));

test("saves creative indirectness level seven as the browser default", () => {
  render(<SettingsPage />);
  const slider = screen.getByRole("slider", { name: "여자어 기본 강도" });

  expect(slider).toHaveAttribute("max", "7");
  fireEvent.change(slider, { target: { value: "7" } });
  fireEvent.click(screen.getByRole("button", { name: "기본 강도 저장" }));

  expect(window.localStorage.getItem("reply-default-indirectness")).toBe("7");
  expect(screen.getByText("기본 강도를 저장했어요.")).toHaveAttribute("role", "status");
});

test("restores a saved creative indirectness level seven", () => {
  window.localStorage.setItem("reply-default-indirectness", "7");
  render(<SettingsPage />);

  expect(screen.getByRole("slider", { name: "여자어 기본 강도" })).toHaveValue("7");
});
