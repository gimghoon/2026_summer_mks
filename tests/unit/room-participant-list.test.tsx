import { render, screen } from "@testing-library/react";
import { RoomParticipantList } from "@/components/room-participant-list";

test("shows named participant profile and reply links without exposing IDs", () => {
  render(<RoomParticipantList room={{ id: "room-1", title: "민수", updatedAt: "2026-08-08T00:00:00.000Z", participants: [
    { id: "self-1", name: "나", isSelf: true, relationshipStyle: null },
    { id: "person-1", name: "민수", isSelf: false, relationshipStyle: "female_friend" },
  ] }} />);
  expect(screen.getByRole("link", { name: "민수 프로필" })).toHaveAttribute("href", "/rooms/room-1/profiles/person-1");
  expect(screen.getByRole("link", { name: "민수 답장 만들기" })).toHaveAttribute("href", "/rooms/room-1/reply?participantId=person-1");
  expect(screen.queryByText("person-1")).not.toBeInTheDocument();
});
