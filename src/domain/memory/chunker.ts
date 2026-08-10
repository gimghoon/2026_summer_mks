import type { ParsedTurn } from "@/domain/kakao/turns";

const THIRTY_MINUTES_MS = 30 * 60 * 1_000;
const MAX_TURNS_PER_CHUNK = 20;
const SEOUL_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export type ConversationChunk = {
  startTurnIndex: number;
  endTurnIndex: number;
  startedAt: Date;
  endedAt: Date;
};

function validateTopicBoundaries(boundaries: number[], turnCount: number): void {
  let previous = -1;

  for (const boundary of boundaries) {
    if (!Number.isInteger(boundary)) {
      throw new TypeError("Topic boundaries must be integers");
    }
    if (boundary < 0 || boundary >= turnCount) {
      throw new RangeError("Topic boundaries must be inside the turn range");
    }
    if (boundary <= previous) {
      throw new RangeError("Topic boundaries must be sorted and unique");
    }
    previous = boundary;
  }
}

function seoulCalendarDate(date: Date): string {
  return SEOUL_DATE_FORMATTER.format(date);
}

function toChunk(turns: ParsedTurn[], startTurnIndex: number, endTurnIndex: number): ConversationChunk {
  return {
    startTurnIndex,
    endTurnIndex,
    startedAt: turns[startTurnIndex]!.startedAt,
    endedAt: turns[endTurnIndex]!.endedAt,
  };
}

export function chunkTurns(turns: ParsedTurn[], topicBoundaries: number[]): ConversationChunk[] {
  validateTopicBoundaries(topicBoundaries, turns.length);

  if (turns.length === 0) {
    return [];
  }

  const boundaries = new Set(topicBoundaries);
  const chunks: ConversationChunk[] = [];
  let chunkStart = 0;

  for (let index = 1; index < turns.length; index += 1) {
    const previous = turns[index - 1]!;
    const current = turns[index]!;
    const gap = current.startedAt.getTime() - previous.endedAt.getTime();
    const reachedTurnLimit = index - chunkStart >= MAX_TURNS_PER_CHUNK;
    const startsNewChunk =
      reachedTurnLimit
      || gap >= THIRTY_MINUTES_MS
      || seoulCalendarDate(previous.endedAt) !== seoulCalendarDate(current.startedAt)
      || boundaries.has(index);

    if (startsNewChunk) {
      chunks.push(toChunk(turns, chunkStart, index - 1));
      chunkStart = index;
    }
  }

  chunks.push(toChunk(turns, chunkStart, turns.length - 1));
  return chunks;
}
