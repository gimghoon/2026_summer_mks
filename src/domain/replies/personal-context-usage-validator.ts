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

export type PersonalContextUsageValidator = (
  candidates: [
    PersonalContextUsageCandidate,
    PersonalContextUsageCandidate,
    PersonalContextUsageCandidate,
  ],
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
  return async (candidates) => {
    const response = await gateway.extract({
      purpose: "reply",
      schemaName: "personal_context_usage_check",
      schema: semanticUsageSchema,
      system: [
        "Evaluate three reply candidates for natural semantic use of their selected personal-context facts.",
        "A fact is reflected when it naturally influences the reply's wording, framing, or choice of request; it does not need verbatim wording.",
        "Reject verbatim profile disclosure, profiling language, or explanations of the facts.",
        "Return only the three strategy booleans in the supplied order, with no explanations.",
      ].join(" "),
      input: JSON.stringify({ candidates }),
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
