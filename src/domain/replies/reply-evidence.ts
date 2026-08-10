export type ProfileEvidenceInput = {
  kind: string;
  value: string;
  conditions?: string[];
  exceptions?: string[];
};

export type PersonalContextEvidence = { id: string; summary: string };

export const NO_PERSONAL_CONTEXT_BASIS = "현재 상황과 답장 의도만 사용";

function normalizeWhitespace(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function summarizeList(values: string[] | undefined): string {
  return (values ?? []).map(normalizeWhitespace).filter(Boolean).join(", ");
}

function truncateCodePoints(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join("");
}

export function buildPersonalContextEvidence(
  profiles: ProfileEvidenceInput[],
): PersonalContextEvidence[] {
  return profiles.map((profile, index) => {
    const sections = [`${normalizeWhitespace(profile.kind)}: ${normalizeWhitespace(profile.value)}`];
    const conditions = summarizeList(profile.conditions);
    const exceptions = summarizeList(profile.exceptions);
    if (conditions) sections.push(`조건: ${conditions}`);
    if (exceptions) sections.push(`예외: ${exceptions}`);
    return { id: `profile-${index}`, summary: truncateCodePoints(sections.join(" · "), 120) };
  });
}

export function resolveContextBasis(
  ids: string[],
  evidence: PersonalContextEvidence[],
): string[] {
  const summariesById = new Map(evidence.map((entry) => [entry.id, entry.summary]));
  const seen = new Set<string>();
  const summaries = ids.flatMap((id) => {
    if (seen.has(id)) return [];
    seen.add(id);
    const summary = summariesById.get(id);
    return summary ? [summary] : [];
  }).slice(0, 2);
  return summaries.length > 0 ? summaries : [NO_PERSONAL_CONTEXT_BASIS];
}
