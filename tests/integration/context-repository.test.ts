import type { ContextChunkCandidate, ContextQuery } from "@/domain/retrieval/context-repository";
import { VectorContextRepository } from "@/domain/retrieval/vector-context-repository";

function candidate(input: Partial<ContextChunkCandidate> & Pick<ContextChunkCandidate, "chunkId" | "roomId">) {
  const decrypt = vi.fn(async () => ({
    summary: `${input.chunkId} summary`,
    turns: [],
  }));
  return {
    startedAt: new Date("2026-08-07T00:00:00.000Z"),
    embedding: [1, 0],
    participantIds: [],
    topicTags: [],
    eventTypes: [],
    nicknames: [],
    sensitiveTopics: [],
    ...input,
    decrypt,
  } satisfies ContextChunkCandidate;
}

const query: ContextQuery = {
  roomId: "room-a",
  participantIds: ["participant-a"],
  queryEmbedding: [1, 0],
  topics: ["영화"],
  eventTypes: ["약속"],
  nicknames: ["별명"],
  limit: 5,
};

test("ranks room-local hybrid matches before decrypting at most five chunks", async () => {
  const strongest = candidate({
    chunkId: "strongest",
    roomId: "room-a",
    participantIds: ["participant-a"],
    topicTags: ["영화"],
    eventTypes: ["약속"],
    nicknames: ["별명"],
  });
  const crossRoom = candidate({ chunkId: "cross-room", roomId: "room-b" });
  const irrelevant = candidate({ chunkId: "irrelevant", roomId: "room-a", embedding: [0, 1] });
  const otherRelevant = Array.from({ length: 5 }, (_, index) => candidate({
    chunkId: `other-${index}`,
    roomId: "room-a",
    participantIds: ["participant-a"],
  }));
  const source = { listRankableChunks: vi.fn(async () => [strongest, crossRoom, irrelevant, ...otherRelevant]) };
  const repository = new VectorContextRepository(source, () => new Date("2026-08-08T00:00:00.000Z"));

  const retrieved = await repository.findRelevant(query);

  expect(source.listRankableChunks).toHaveBeenCalledWith("room-a");
  expect(retrieved.map((chunk) => chunk.chunkId)).toEqual([
    "strongest", "other-0", "other-1", "other-2", "other-3",
  ]);
  expect(retrieved).toHaveLength(5);
  expect(crossRoom.decrypt).not.toHaveBeenCalled();
  expect(irrelevant.decrypt).not.toHaveBeenCalled();
  expect(otherRelevant[4]!.decrypt).not.toHaveBeenCalled();
  expect(strongest.decrypt).toHaveBeenCalledOnce();
});

test("excludes a semantically similar group-chat chunk that lacks the required person", async () => {
  const target = candidate({ chunkId: "target", roomId: "room-a", participantIds: ["participant-a"] });
  const otherPerson = candidate({ chunkId: "other", roomId: "room-a", participantIds: ["participant-b"] });
  const repository = new VectorContextRepository({ listRankableChunks: async () => [otherPerson, target] });

  const retrieved = await repository.findRelevant({
    ...query,
    requiredParticipantIds: ["participant-a"],
  });

  expect(retrieved.map((chunk) => chunk.chunkId)).toEqual(["target"]);
  expect(otherPerson.decrypt).not.toHaveBeenCalled();
});
