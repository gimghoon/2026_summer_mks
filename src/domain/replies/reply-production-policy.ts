import type { ContextSufficiency, DecryptedTurn } from "@/domain/replies/context-expander";
import type {
  GenerateRepliesCommand,
  ReplyCandidateContent,
  ReplyGenerationContext,
} from "@/domain/replies/reply-service";

const factPolarity = [
  {
    positive: /좋아(?:해|한다|해요)?/u,
    negative: /싫어(?:해|한다|해요)?|안\s*좋아(?:해|한다|해요)?|좋아하지\s*않/u,
  },
  { positive: /있(?:어|다|어요)/u, negative: /없(?:어|다|어요)/u },
  { positive: /가능(?:해|하다|합니다)?/u, negative: /불가능|어려워|가능하지\s*않/u },
  { positive: /원해|원한다/u, negative: /원하지\s*않/u },
] as const;

const ignoredFactTerms = new Set([
  "상대", "나는", "그리고", "하지만", "오늘", "다음", "답장", "대화", "상황", "의도",
]);

function tokens(text: string): string[] {
  return text.normalize("NFKC").toLocaleLowerCase()
    .match(/[가-힣a-z0-9]+/giu)?.map((token) => token.replace(
      /(?:은|는|이|가|을|를|와|과|도|만|의|에|에서|에게|한테)$/u,
      "",
    )).filter((token) => token.length >= 2 && !ignoredFactTerms.has(token)) ?? [];
}

function polarity(text: string): "positive" | "negative" | null {
  for (const pair of factPolarity) {
    if (pair.negative.test(text)) return "negative";
    if (pair.positive.test(text)) return "positive";
  }
  return null;
}

function hasFactAnchor(left: string, right: string): boolean {
  const leftTerms = new Set(tokens(left));
  return tokens(right).some((term) => leftTerms.has(term));
}

function knownFactTexts(context: ReplyGenerationContext): string[] {
  return [
    // `currentFacts` is populated only from reviewed structured profile facts
    // by the production adapter. Raw conversation remains model context, not
    // an authority capable of invalidating a generated reply.
    ...(context.currentFacts ?? []),
    ...context.participantProfiles.flatMap((profile) => [
      profile.value,
      ...(profile.conditions ?? []),
      ...(profile.exceptions ?? []),
    ]),
  ];
}

/**
 * Guards simple, explicit polarity conflicts against reviewed structured
 * participant/profile facts. It returns only a boolean so retry metadata
 * remains the opaque FACT_CONTRADICTION rule ID.
 */
export function validatesReplyFact(candidate: ReplyCandidateContent, context: ReplyGenerationContext): boolean {
  const candidatePolarity = polarity(candidate.text);
  if (!candidatePolarity) return true;
  return !knownFactTexts(context).some((fact) => {
    const factPolarityValue = polarity(fact);
    return factPolarityValue !== null
      && factPolarityValue !== candidatePolarity
      && hasFactAnchor(fact, candidate.text);
  });
}

/** Represents the newly pasted exchange and its user-supplied framing as current context. */
export function submittedCurrentTurn(command: GenerateRepliesCommand): DecryptedTurn {
  return {
    id: "submitted-current-context",
    speakerId: command.participantId,
    startedAt: new Date(),
    messages: [
      { kind: "text", text: command.pastedConversation },
      { kind: "text", text: command.situation },
      { kind: "text", text: command.intent },
    ],
  };
}

/** Requires enough user-provided detail even when saved room history is long. */
export function createSubmittedContextJudge(
  command: GenerateRepliesCommand,
): (turns: DecryptedTurn[]) => Promise<ContextSufficiency> {
  const submittedTokenCount = tokens(command.pastedConversation).length;
  const situationTokenCount = tokens(command.situation).length;
  const intentTokenCount = tokens(command.intent).length;
  return async (turns) => {
    const selectedTokenCount = tokens(turns.flatMap((turn) => (
      turn.messages.map((message) => message.text)
    )).join("\n")).length;
    const sufficient = submittedTokenCount >= 5
      && selectedTokenCount >= 5
      && situationTokenCount >= 2
      && intentTokenCount >= 1;
    return {
      sufficient,
      ambiguityReasons: sufficient ? [] : ["low_information"],
    };
  };
}
