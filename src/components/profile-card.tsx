"use client";

export type ProfileFact = {
  id: string;
  kind: string;
  value: string;
  conditions: string[];
  exceptions: string[];
  confidence: number;
  source: "ai_inference" | "user_confirmed" | "user_edited" | "ai_change_proposal";
  locked: boolean;
  evidenceTurnIds: string[];
};

export const kindLabels: Record<string, string> = {
  relationship: "관계", personality_tendency: "관찰된 성향", speech_pattern: "말투", conversation_role: "대화 역할",
  seriousness_cue: "진지함 단서", preferred_interaction: "선호하는 대화", sensitive_topic: "민감한 주제",
  interest: "관심사", nickname: "별명", repeated_event: "반복된 사건", conflict_response: "갈등 반응", reconciliation_style: "화해 방식",
};
const sourceLabels: Record<ProfileFact["source"], string> = { ai_inference: "AI 추정", user_confirmed: "사용자 확인", user_edited: "직접 수정", ai_change_proposal: "AI 제안" };

export function ProfileCard({ fact, onEdit }: { fact: ProfileFact; onEdit: (fact: ProfileFact) => void }) {
  return <article className="profile-card">
    <div className="profile-card__heading"><div><p className="eyebrow">{kindLabels[fact.kind] ?? fact.kind}</p><h3>{fact.value}</h3></div><span className="confidence">확신 {Math.round(fact.confidence * 100)}%</span></div>
    <dl className="fact-grid">
      <div><dt>출처</dt><dd>{sourceLabels[fact.source]}</dd></div><div><dt>근거</dt><dd>{fact.evidenceTurnIds.length}개 대화</dd></div>
      <div><dt>조건</dt><dd>{fact.conditions.join(", ") || "없음"}</dd></div><div><dt>예외</dt><dd>{fact.exceptions.join(", ") || "없음"}</dd></div>
    </dl>
    <div className="profile-card__footer"><span className={fact.locked ? "lock-badge is-locked" : "lock-badge"}>{fact.locked ? "잠금됨" : "검토 중"}</span><button type="button" className="text-button" onClick={() => onEdit(fact)}>직접 수정</button></div>
  </article>;
}
