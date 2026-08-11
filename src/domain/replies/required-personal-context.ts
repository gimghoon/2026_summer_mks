import type { ProfileFactSource } from "@/db/schema";
import type { ParticipantProfileContext } from "@/domain/replies/reply-service";

export type RequiredPersonalContextSelection = {
  facts: ParticipantProfileContext[];
  inferenceOnly: boolean;
};

export const PERSONAL_CONTEXT_UNAVAILABLE_MESSAGE =
  "사용할 개인 컨텍스트가 없어요. 프로필을 먼저 확인하거나 직접 추가해 주세요.";

const trustedRank: Partial<Record<ProfileFactSource, number>> = {
  user_edited: 0,
  user_confirmed: 1,
};

export function selectRequiredPersonalContext(
  profiles: ParticipantProfileContext[],
): RequiredPersonalContextSelection {
  const nonProposals = profiles.filter((fact) => fact.source !== "ai_change_proposal");
  const trusted = nonProposals
    .filter((fact) => fact.source === "user_edited"
      || fact.source === "user_confirmed"
      || fact.locked)
    .sort((left, right) => {
      const leftRank = trustedRank[left.source] ?? 2;
      const rightRank = trustedRank[right.source] ?? 2;
      return leftRank - rightRank || left.id.localeCompare(right.id);
    });
  if (trusted.length > 0) return { facts: trusted, inferenceOnly: false };
  return {
    facts: nonProposals
      .filter((fact) => fact.source === "ai_inference")
      .sort((left, right) => left.id.localeCompare(right.id)),
    inferenceOnly: true,
  };
}

export function invalidRequiredBasisIds(
  ids: string[],
  allowedFactIds: ReadonlySet<string>,
): boolean {
  return ids.length === 0 || ids.some((id) => !allowedFactIds.has(id));
}
