import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProfileEditor } from "@/components/profile-editor";

test("saves a direct correction with its conditions and exceptions", async () => {
  const onSaved = vi.fn();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "f1", kind: "personality_tendency", value: "친한 사람에게만 장난이 많음", conditions: ["친한 사람"], exceptions: ["갈등 중"], confidence: 1, source: "user_edited", locked: true, evidenceTurnIds: [] }) }));
  render(<ProfileEditor roomId="11111111-1111-4111-8111-111111111111" participantId="p1" onSaved={onSaved} />);
  fireEvent.change(screen.getByLabelText("관찰된 성향"), { target: { value: "친한 사람에게만 장난이 많음" } });
  fireEvent.change(screen.getByLabelText("적용 조건"), { target: { value: "친한 사람" } });
  fireEvent.change(screen.getByLabelText("예외"), { target: { value: "갈등 중" } });
  fireEvent.click(screen.getByRole("button", { name: "저장" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ value: "친한 사람에게만 장난이 많음", locked: true })));
  expect(fetch).toHaveBeenCalledWith("/api/profiles/p1", expect.objectContaining({ method: "PATCH" }));
  vi.unstubAllGlobals();
});
