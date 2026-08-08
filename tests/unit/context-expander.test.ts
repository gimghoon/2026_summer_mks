import { selectCurrentContext, type DecryptedTurn } from "@/domain/replies/context-expander";

function makeTurns(count: number, latestText = "오늘 저녁에 같이 영화 보러 가자 괜찮아"): DecryptedTurn[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `turn-${index}`,
    speakerId: `speaker-${index % 2}`,
    startedAt: new Date(`2026-08-07T00:${String(index % 60).padStart(2, "0")}:00.000Z`),
    messages: [{ kind: "text" as const, text: index === count - 1 ? latestText : "오늘 저녁에 같이 영화 보러 가자 괜찮아" }],
  }));
}

test("expands only until context becomes sufficient", async () => {
  const judge = vi.fn()
    .mockResolvedValueOnce({ sufficient: false, ambiguityReasons: ["unclear_reference"] })
    .mockResolvedValueOnce({ sufficient: true, ambiguityReasons: [] });

  const result = await selectCurrentContext({ turns: makeTurns(100), judge, fullChunkStart: 0 });

  expect(result.usedTurnLimit).toBe(40);
  expect(result.needsUserQuestion).toBe(false);
  expect(result.turns).toHaveLength(40);
  expect(judge.mock.calls.map(([turns]) => turns.length)).toEqual([20, 40]);
});

test("uses the complete 20, 40, 80, and full-chunk sequence when needed", async () => {
  const judge = vi.fn()
    .mockResolvedValueOnce({ sufficient: false, ambiguityReasons: ["past_event_missing"] })
    .mockResolvedValueOnce({ sufficient: false, ambiguityReasons: ["past_event_missing"] })
    .mockResolvedValueOnce({ sufficient: false, ambiguityReasons: ["past_event_missing"] })
    .mockResolvedValueOnce({ sufficient: true, ambiguityReasons: [] });

  const result = await selectCurrentContext({ turns: makeTurns(100), judge, fullChunkStart: 0 });

  expect(judge.mock.calls.map(([turns]) => turns.length)).toEqual([20, 40, 80, 100]);
  expect(result).toMatchObject({ usedTurnLimit: "full_chunk", needsUserQuestion: false });
  expect(result.turns).toHaveLength(100);
});

test("uses deterministic ambiguity checks before the model and asks one Korean question after the full chunk", async () => {
  const judge = vi.fn();
  const turns = makeTurns(100);
  turns[98] = {
    ...turns[98]!,
    messages: [{ kind: "text", text: "그거 어떻게 할까" }],
  };

  const result = await selectCurrentContext({
    turns,
    judge,
    fullChunkStart: 0,
  });

  expect(judge).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    usedTurnLimit: "full_chunk",
    needsUserQuestion: true,
    turns: expect.arrayContaining([expect.objectContaining({ id: "turn-0" })]),
  });
  expect(result.question).toMatch(/[가-힣]/);
  expect(result.question).toMatch(/어떤 사람이나 일/);
});
