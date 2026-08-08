import type { DecryptedTurn } from "@/domain/retrieval/context-repository";

export type { DecryptedTurn } from "@/domain/retrieval/context-repository";

export type AmbiguityReason =
  | "low_information"
  | "unclear_reference"
  | "past_event_missing"
  | "emotion_ambiguous"
  | "relationship_conflict";

export type ContextSufficiency = {
  sufficient: boolean;
  ambiguityReasons: AmbiguityReason[];
};

export type CurrentContextSelection = {
  turns: DecryptedTurn[];
  usedTurnLimit: 20 | 40 | 80 | "full_chunk";
  needsUserQuestion: boolean;
  question?: string;
};

export type ContextExpansionInput = {
  turns: DecryptedTurn[];
  fullChunkStart: number;
  judge: (turns: DecryptedTurn[]) => Promise<ContextSufficiency>;
};

const unresolvedReferenceStems = [
  "그", "그거", "그것", "그사람", "그분", "걔", "그때", "그일", "그얘기", "저거", "저것", "이거", "이것",
] as const;

// Match only common particles and copula endings after known reference stems.
// This deliberately does not turn arbitrary 그-prefix words (for example, 그래서)
// into ambiguous references.
const referenceSuffixes = new Set([
  "", "은", "는", "이", "가", "을", "를", "에", "에게", "한테", "에서", "으로", "로", "도", "만", "와", "과", "의",
  "야", "이다", "이야", "예요", "이에요", "인가", "일까", "였어", "였나",
]);

function isUnresolvedReferenceToken(token: string): boolean {
  return unresolvedReferenceStems.some((stem) => (
    token.startsWith(stem) && referenceSuffixes.has(token.slice(stem.length))
  ));
}

function lexicalTokens(turns: DecryptedTurn[]): string[] {
  return turns.flatMap((turn) => turn.messages)
    .filter((message) => message.kind === "text")
    .flatMap((message) => message.text.match(/[가-힣A-Za-z0-9]+/g) ?? [])
    .filter((token) => !/^[ㅋㅎ]+$/.test(token));
}

function isEventOrLaughterOnly(turn: DecryptedTurn): boolean {
  return turn.messages.length > 0 && turn.messages.every((message) => (
    message.kind !== "text" || /^\s*[ㅋㅎ]+\s*$/.test(message.text)
  ));
}

function hasUnresolvedReference(turns: DecryptedTurn[]): boolean {
  return turns.some((turn) => turn.messages.some((message) => {
    if (message.kind !== "text") return false;
    const tokens = message.text.match(/[가-힣A-Za-z0-9]+/g) ?? [];
    return tokens.some(isUnresolvedReferenceToken);
  }));
}

function deterministicAmbiguity(turns: DecryptedTurn[]): AmbiguityReason[] {
  const reasons: AmbiguityReason[] = [];
  if (lexicalTokens(turns).length < 6) reasons.push("low_information");
  if (turns.length > 0 && turns.filter(isEventOrLaughterOnly).length / turns.length > 0.7) {
    reasons.push("emotion_ambiguous");
  }
  if (hasUnresolvedReference(turns)) reasons.push("unclear_reference");
  return reasons;
}

function koreanClarificationQuestion(reasons: AmbiguityReason[]): string {
  if (reasons.includes("unclear_reference")) {
    return "어떤 사람이나 일을 말씀하시는 건지 조금만 더 알려주실 수 있을까요?";
  }
  if (reasons.includes("past_event_missing")) {
    return "어떤 지난 일을 말하는 건지 조금만 더 알려주실 수 있을까요?";
  }
  if (reasons.includes("emotion_ambiguous")) {
    return "상대방의 기분이나 반응이 어땠는지 조금만 더 알려주실 수 있을까요?";
  }
  if (reasons.includes("relationship_conflict")) {
    return "두 분의 관계와 지금 상황을 조금만 더 알려주실 수 있을까요?";
  }
  return "상대가 한 말과 현재 상황을 조금만 더 알려주실 수 있을까요?";
}

function selectionForLimit(
  turns: DecryptedTurn[],
  fullChunkStart: number,
  limit: CurrentContextSelection["usedTurnLimit"],
): DecryptedTurn[] {
  if (limit === "full_chunk") return turns.slice(fullChunkStart);
  return turns.slice(Math.max(fullChunkStart, turns.length - limit));
}

function sameTurnIds(left: DecryptedTurn[], right: DecryptedTurn[]): boolean {
  return left.length === right.length && left.every((turn, index) => turn.id === right[index]?.id);
}

function assertValidInput(input: ContextExpansionInput): void {
  if (!Number.isInteger(input.fullChunkStart) || input.fullChunkStart < 0 || input.fullChunkStart > input.turns.length) {
    throw new Error("fullChunkStart must be a valid turn index");
  }
}

/** Expands newest context deterministically from 20 to the current chunk. */
export async function selectCurrentContext(input: ContextExpansionInput): Promise<CurrentContextSelection> {
  assertValidInput(input);
  const limits: CurrentContextSelection["usedTurnLimit"][] = [20, 40, 80, "full_chunk"];
  let previousTurns: DecryptedTurn[] | undefined;
  let latestReasons: AmbiguityReason[] = ["low_information"];

  for (const limit of limits) {
    const turns = selectionForLimit(input.turns, input.fullChunkStart, limit);
    if (previousTurns && sameTurnIds(previousTurns, turns)) continue;
    previousTurns = turns;

    const deterministicReasons = deterministicAmbiguity(turns);
    if (deterministicReasons.length > 0) {
      latestReasons = deterministicReasons;
      continue;
    }

    const sufficiency = await input.judge(turns);
    latestReasons = sufficiency.ambiguityReasons;
    if (sufficiency.sufficient) {
      return { turns, usedTurnLimit: limit, needsUserQuestion: false };
    }
  }

  const fullChunkTurns = selectionForLimit(input.turns, input.fullChunkStart, "full_chunk");
  return {
    turns: fullChunkTurns,
    usedTurnLimit: "full_chunk",
    needsUserQuestion: true,
    question: koreanClarificationQuestion(latestReasons),
  };
}
