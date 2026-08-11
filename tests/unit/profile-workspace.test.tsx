import { render, screen } from "@testing-library/react";
import { ProfileWorkspace } from "@/components/profile-workspace";

vi.mock("next/navigation", () => ({ usePathname: () => "/rooms/room-1/profiles/person-1" }));

afterEach(() => vi.unstubAllGlobals());

test("shows the selected participant name in the profile workspace", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ facts: [] }),
  }));

  render(<ProfileWorkspace
    roomId="room-1"
    participantId="person-1"
    participantName="유나"
    relationship="female_friend"
  />);

  expect(screen.getByText("유나 프로필 검수", { exact: true })).toBeVisible();
  expect(await screen.findByRole("region", { name: "분석된 프로필 사실" })).toBeVisible();
});
