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

test.each(["걔는", "그거야", "그것을"])("expands for the inflected unresolved reference %s", async (reference) => {
  const judge = vi.fn().mockResolvedValue({ sufficient: true, ambiguityReasons: [] });
  const turns = makeTurns(20);
  turns[turns.length - 2] = {
    ...turns[turns.length - 2]!,
    messages: [{ kind: "text", text: `${reference} 오늘 예약 전에 어떻게 처리할지 알려줘` }],
  };

  const result = await selectCurrentContext({ turns, judge, fullChunkStart: 0 });

  expect(judge).not.toHaveBeenCalled();
  expect(result).toMatchObject({ usedTurnLimit: "full_chunk", needsUserQuestion: true });
});

test("ignores an old reference when the latest three text turns are clear", async () => {
  const judge = vi.fn().mockResolvedValue({ sufficient: true, ambiguityReasons: [] });
  const turns = makeTurns(20);
  turns[10] = {
    ...turns[10]!,
    messages: [{ kind: "text", text: "그거 어떻게 할까" }],
  };

  const result = await selectCurrentContext({ turns, judge, fullChunkStart: 0 });

  expect(judge).toHaveBeenCalledOnce();
  expect(result).toMatchObject({ usedTurnLimit: 20, needsUserQuestion: false });
});

test("accepts a resolved recent person reference", async () => {
  const judge = vi.fn().mockResolvedValue({ sufficient: true, ambiguityReasons: [] });
  const turns = makeTurns(20, "걔는 아직 예약할 돈을 보내지 않고 있어서 기다리는 중이야");

  const result = await selectCurrentContext({
    turns,
    judge,
    fullChunkStart: 0,
    resolvedPersonReference: true,
  });

  expect(judge).toHaveBeenCalledOnce();
  expect(result.needsUserQuestion).toBe(false);
});

test("accepts a resolved spaced person reference", async () => {
  const judge = vi.fn().mockResolvedValue({ sufficient: true, ambiguityReasons: [] });
  const turns = makeTurns(20, "그 사람은 아직 예약할 돈을 보내지 않고 있어서 기다리는 중이야");

  const result = await selectCurrentContext({
    turns,
    judge,
    fullChunkStart: 0,
    resolvedPersonReference: true,
  });

  expect(judge).toHaveBeenCalledOnce();
  expect(result.needsUserQuestion).toBe(false);
});

test("does not treat an explicit person as resolving a recent object reference", async () => {
  const judge = vi.fn().mockResolvedValue({ sufficient: true, ambiguityReasons: [] });
  const turns = makeTurns(20, "그거 어떻게 할지 오늘 예약 전에 빨리 알려줘");

  const result = await selectCurrentContext({
    turns,
    judge,
    fullChunkStart: 0,
    resolvedPersonReference: true,
  });

  expect(judge).not.toHaveBeenCalled();
  expect(result.needsUserQuestion).toBe(true);
});

test("does not treat an arbitrary 그-prefix word as an unresolved reference", async () => {
  const judge = vi.fn().mockResolvedValue({ sufficient: true, ambiguityReasons: [] });
  const turns = makeTurns(20);
  turns[10] = {
    ...turns[10]!,
    messages: [{ kind: "text", text: "그래서 오늘 저녁에 같이 영화 보러 가자" }],
  };

  const result = await selectCurrentContext({ turns, judge, fullChunkStart: 0 });

  expect(judge).toHaveBeenCalledOnce();
  expect(result).toMatchObject({ usedTurnLimit: 20, needsUserQuestion: false });
});
