import type { ParsedTurn } from "@/domain/kakao/turns";
import { chunkTurns } from "@/domain/memory/chunker";

const BASE_TIME = Date.parse("2026-08-07T00:00:00.000Z");

function turnsAtMinutes(minutes: number[]): ParsedTurn[] {
  return minutes.map((minute, index) => {
    const at = new Date(BASE_TIME + minute * 60_000);
    return {
      speaker: `speaker-${index % 2}`,
      startedAt: at,
      endedAt: at,
      messages: [],
    };
  });
}

test("splits at thirty-minute gaps and explicit topic boundaries", () => {
  const chunks = chunkTurns(turnsAtMinutes([0, 2, 33, 34, 36]), [4]);

  expect(chunks.map((chunk) => [chunk.startTurnIndex, chunk.endTurnIndex])).toEqual([
    [0, 1],
    [2, 3],
    [4, 4],
  ]);
});

test("treats an exact thirty-minute gap as a boundary", () => {
  const chunks = chunkTurns(turnsAtMinutes([0, 30]), []);

  expect(chunks.map((chunk) => [chunk.startTurnIndex, chunk.endTurnIndex])).toEqual([
    [0, 0],
    [1, 1],
  ]);
});

test("splits when the Asia/Seoul calendar date changes", () => {
  const beforeMidnight = new Date("2026-08-07T14:59:00.000Z");
  const afterMidnight = new Date("2026-08-07T15:00:00.000Z");
  const turns: ParsedTurn[] = [beforeMidnight, afterMidnight].map((at) => ({
    speaker: "민수",
    startedAt: at,
    endedAt: at,
    messages: [],
  }));

  const chunks = chunkTurns(turns, []);

  expect(chunks.map((chunk) => [chunk.startTurnIndex, chunk.endTurnIndex])).toEqual([
    [0, 0],
    [1, 1],
  ]);
});

test("uses the first and last turns for chunk timestamps", () => {
  const turns = turnsAtMinutes([0, 2]);
  turns[1]!.endedAt = new Date(BASE_TIME + 3 * 60_000);

  expect(chunkTurns(turns, [])).toEqual([{
    startTurnIndex: 0,
    endTurnIndex: 1,
    startedAt: new Date(BASE_TIME),
    endedAt: new Date(BASE_TIME + 3 * 60_000),
  }]);
});

test("returns no chunks for no turns", () => {
  expect(chunkTurns([], [])).toEqual([]);
});

test("caps a continuous conversation at twenty turns per chunk", () => {
  const turns = Array.from({ length: 136 }, (_, index) => {
    const at = new Date(BASE_TIME + index * 60_000);
    return {
      speaker: `speaker-${index % 2}`,
      startedAt: at,
      endedAt: at,
      messages: [],
    } satisfies ParsedTurn;
  });

  const result = chunkTurns(turns, []);

  expect(result.map((chunk) => chunk.endTurnIndex - chunk.startTurnIndex + 1))
    .toEqual([20, 20, 20, 20, 20, 20, 16]);
});

test.each([
  { label: "not integers", boundaries: [1.5] },
  { label: "outside the turn range", boundaries: [2] },
  { label: "not sorted", boundaries: [1, 0] },
  { label: "not unique", boundaries: [1, 1] },
])("rejects topic boundaries that are $label", ({ boundaries }) => {
  expect(() => chunkTurns(turnsAtMinutes([0, 1]), boundaries)).toThrow(/Topic boundaries/);
});
