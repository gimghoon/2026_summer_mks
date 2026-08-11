"use client";

import { useEffect, useState } from "react";
import type { ReplyCandidate, ReplyWarning } from "@/domain/replies/reply-service";

export type { ReplyCandidate } from "@/domain/replies/reply-service";
const strategyLabels = { relationship_soft: "부드럽게 관계 지키기", emotion_signal: "은근히 눈치 주기", clearer_request: "조금 더 분명하게 말하기" } as const;
const warningLabels: Record<ReplyWarning, string> = {
  emotional_inference: "감정 해석 포함",
  duplicate_text: "답장 간 표현 유사",
  relationship_boundary: "관계 범위 주의",
  agency_or_safety: "갈등·안전 주의",
  personal_style_mismatch: "평소 말투와 다를 수 있음",
  specific_fact_inference: "사실 추측 포함",
  profile_conflict: "프로필과 다를 수 있음",
  important_intent_ambiguity: "중요 의도 불명확",
  unverified_profile_context: "AI 추론 프로필을 확인해 주세요",
};

export function ReplyResults({ candidates, clarification, onRetry }: { candidates?: ReplyCandidate[]; clarification?: string; onRetry?: (answer: string) => void }) {
  const [localCandidates, setLocalCandidates] = useState(candidates ?? []); const [editing, setEditing] = useState<string | null>(null); const [draft, setDraft] = useState(""); const [copied, setCopied] = useState(""); const [answer, setAnswer] = useState("");
  useEffect(() => { setLocalCandidates(candidates ?? []); setEditing(null); }, [candidates]);
  function saveDraft(strategy: ReplyCandidate["strategy"]) { setLocalCandidates((current) => current.map((candidate) => candidate.strategy === strategy ? { ...candidate, text: draft } : candidate)); setEditing(null); }
  async function copy(text: string, strategy: string) { if (!navigator.clipboard?.writeText) { setCopied("이 브라우저에서는 자동 복사를 지원하지 않아요. 내용을 길게 눌러 복사해 주세요."); return; } try { await navigator.clipboard.writeText(text); setCopied(strategy); } catch { setCopied("복사 권한이 없어요. 내용을 길게 눌러 복사해 주세요."); } }
  if (clarification) return <section className="clarification" aria-live="polite"><p className="eyebrow">한 가지만 확인할게요</p><h2>{clarification}</h2><label>추가 설명<input value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="상황을 짧게 적어 주세요" /></label><button className="primary-button" disabled={!answer.trim()} onClick={() => onRetry?.(answer)}>답장 다시 만들기</button></section>;
  return <section className="reply-results" aria-live="polite"><div className="section-heading"><div><p className="eyebrow">답장 추천</p><h2>지금의 마음을 세 가지로</h2></div><span className="count-chip">3개</span></div>{localCandidates.slice(0, 3).map((candidate, index) => {
    const warnings = [...new Set(candidate.warnings)];
    return <article className="reply-card" data-testid="reply-candidate" key={candidate.strategy}><span className="reply-card__number">0{index + 1}</span><div className="reply-card__body"><p className="strategy-label">{strategyLabels[candidate.strategy]}</p>{editing === candidate.strategy ? <textarea aria-label={`${strategyLabels[candidate.strategy]} 답장 수정`} value={draft} onChange={(event) => setDraft(event.target.value)} rows={3} /> : <p className="reply-text">{candidate.text}</p>}<dl><div><dt>전달 의도</dt><dd>{candidate.intentLabel}</dd></div>{candidate.riskLabel && <div><dt>예상 위험</dt><dd>{candidate.riskLabel}</dd></div>}{candidate.contextBasis.length > 0 && <div className="context-basis"><dt>퍼스널 컨텍스트 근거</dt><dd><ul>{candidate.contextBasis.slice(0, 2).map((basis) => <li key={basis}>{basis}</li>)}</ul></dd></div>}</dl>{warnings.length > 0 && <div className="warning-list"><p>보내기 전 확인</p><ul aria-label="답장 주의 사항">{warnings.map((warning) => <li className="warning-badge" key={warning}>{warningLabels[warning]}</li>)}</ul></div>}{warnings.includes("emotional_inference") && <p className="interpretation-note">감정과 뉘앙스를 창의적으로 해석한 표현이에요. 보내기 전에 실제 의도와 맞는지 확인해 주세요.</p>}<div className="reply-actions">{editing === candidate.strategy ? <button type="button" className="text-button" onClick={() => saveDraft(candidate.strategy)}>수정 완료</button> : <button type="button" className="text-button" onClick={() => { setEditing(candidate.strategy); setDraft(candidate.text); }}>수정</button>}<button type="button" className="copy-button" onClick={() => copy(candidate.text, candidate.strategy)}>복사</button></div></div></article>;
  })}{copied && <p className="copy-notice" role="status">{copied.includes("복사") && copied !== "relationship_soft" && copied !== "emotion_signal" && copied !== "clearer_request" ? copied : "답장을 복사했어요."}</p>}</section>;
}
