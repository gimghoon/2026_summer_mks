import type { ProfileFactSource } from "@/db/schema";

export type MergeableProfileFact = {
  value: string;
  source: ProfileFactSource;
  locked?: boolean;
  confidence?: number;
  conditions?: string[];
  exceptions?: string[];
};

export type ProfileFactMerge = {
  fact: MergeableProfileFact;
  proposal?: MergeableProfileFact;
};

function isUserKnowledge(source: ProfileFactSource): boolean {
  return source === "user_edited" || source === "user_confirmed";
}

/**
 * Merge precedence is intentionally independent of model confidence: explicit
 * user knowledge is authoritative and a conflicting model result is retained
 * only as a reviewable proposal.
 */
export function mergeProfileFact(
  existing: MergeableProfileFact,
  incoming: MergeableProfileFact,
): ProfileFactMerge {
  if (
    incoming.source === "ai_change_proposal"
    || (incoming.source === "ai_inference" && (existing.locked || isUserKnowledge(existing.source)))
  ) {
    return {
      fact: existing,
      proposal: { ...incoming, source: "ai_change_proposal", locked: false },
    };
  }

  return {
    fact: {
      ...existing,
      ...incoming,
      locked: incoming.locked ?? false,
    },
  };
}
