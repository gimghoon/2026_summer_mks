import {
  createRoomDeleteHandler,
} from "@/domain/rooms/room-deletion-api-handler";

const roomId = "11111111-1111-4111-8111-111111111111";

function context(id = roomId) {
  return { params: Promise.resolve({ roomId: id }) };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    requireSession: vi.fn(async () => {}),
    deleteRoom: vi.fn(async () => true),
    enqueueUploadBlobDeletion: vi.fn(async () => {}),
    log: vi.fn(),
    ...overrides,
  };
}

test("room deletion requires a session before looking up the room", async () => {
  const deps = dependencies({
    requireSession: async () => { throw new Response("Unauthorized", { status: 401 }); },
  });
  const handler = createRoomDeleteHandler(deps);

  expect((await handler(new Request("https://assistant.test/api/rooms/x", { method: "DELETE" }), context())).status).toBe(401);
  expect(deps.deleteRoom).not.toHaveBeenCalled();
});

test("deletes the requested room once, queues its blob cleanup, and returns no content", async () => {
  const deps = dependencies();
  const handler = createRoomDeleteHandler(deps);

  const response = await handler(new Request(`https://assistant.test/api/rooms/${roomId}`, { method: "DELETE" }), context());

  expect(response.status).toBe(204);
  expect(await response.text()).toBe("");
  expect(deps.deleteRoom).toHaveBeenCalledTimes(1);
  expect(deps.deleteRoom).toHaveBeenCalledWith(roomId);
  expect(deps.enqueueUploadBlobDeletion).toHaveBeenCalledWith(roomId);
});

test("a repeated delete returns not found without retrying blob cleanup", async () => {
  const deps = dependencies({ deleteRoom: vi.fn(async () => false) });
  const handler = createRoomDeleteHandler(deps);

  const response = await handler(new Request(`https://assistant.test/api/rooms/${roomId}`, { method: "DELETE" }), context());

  expect(response.status).toBe(404);
  expect(deps.enqueueUploadBlobDeletion).not.toHaveBeenCalled();
});

test("an invalid room identifier is indistinguishable from a missing room", async () => {
  const deps = dependencies();
  const handler = createRoomDeleteHandler(deps);

  const response = await handler(new Request("https://assistant.test/api/rooms/not-a-uuid", { method: "DELETE" }), context("not-a-uuid"));

  expect(response.status).toBe(404);
  expect(deps.deleteRoom).not.toHaveBeenCalled();
});
