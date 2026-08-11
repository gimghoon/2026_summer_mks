import { z } from "zod";

import {
  ModelResponseValidationError,
  type ModelGateway,
} from "@/domain/models/gateway";
import type { ReplyStrategy } from "@/db/schema";

const strategyOrder = [
  "relationship_soft",
  "emotion_signal",
  "clearer_request",
] as const satisfies readonly ReplyStrategy[];

export type PersonalContextUsageCandidate = {
  strategy: ReplyStrategy;
  text: string;
  selectedFacts: Array<{
    id: string;
    kind: string;
    value: string;
    conditions: string[];
    exceptions: string[];
  }>;
};

export type PersonalContextUsageGrounding = {
  situation: string;
  intent: string;
  currentTurns: Array<{
    speakerId: string;
    messages: Array<{
      kind: "text" | "media_event" | "deleted_event";
      text: string;
    }>;
  }>;
};

export type PersonalContextUsageValidator = (
  candidates: [
    PersonalContextUsageCandidate,
    PersonalContextUsageCandidate,
    PersonalContextUsageCandidate,
  ],
  grounding: PersonalContextUsageGrounding,
) => Promise<Record<ReplyStrategy, boolean>>;

const semanticUsageSchema = z.object({
  candidates: z.array(z.object({
    strategy: z.enum(strategyOrder),
    reflected: z.boolean(),
  }).strict()).length(3),
}).strict();

export function createPersonalContextUsageValidator(
  gateway: Pick<ModelGateway, "extract">,
): PersonalContextUsageValidator {
  return async (candidates, grounding) => {
    const response = await gateway.extract({
      purpose: "reply",
      schemaName: "personal_context_usage_check",
      schema: semanticUsageSchema,
      system: [
        "Evaluate three reply candidates for natural semantic use of their selected personal-context facts.",
        "A fact is reflected when it naturally influences the reply's wording, framing, or choice of request; it does not need verbatim wording.",
        "A condition, exception, event, or state may be applied only when it is grounded in grounding.situation, grounding.intent, or grounding.currentTurns.",
        "Mark reflected false when the candidate invents or assumes a condition, event, or state not grounded there.",
        "Reject verbatim profile disclosure, profiling language, or explanations of the facts.",
        "Return only the three strategy booleans in the supplied order, with no explanations.",
      ].join(" "),
      input: JSON.stringify({ candidates, grounding }),
    });
    if (!response.candidates.every((candidate, index) => candidate.strategy === strategyOrder[index])) {
      throw new ModelResponseValidationError();
    }
    return Object.fromEntries(response.candidates.map((candidate) => [
      candidate.strategy,
      candidate.reflected,
    ])) as Record<ReplyStrategy, boolean>;
  };
}
