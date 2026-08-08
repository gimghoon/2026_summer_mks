"use client";

import { useEffect, useState } from "react";
import { kindLabels, type ProfileFact } from "./profile-card";

const kinds = Object.keys(kindLabels);

export function ProfileEditor({ participantId, fact, onSaved, onClose }: { participantId: string; fact?: ProfileFact; onSaved?: (fact: ProfileFact) => void; onClose?: () => void }) {
  const [kind, setKind] = useState(fact?.kind ?? "personality_tendency");
  const [value, setValue] = useState(fact?.value ?? "");
  const [conditions, setConditions] = useState(fact?.conditions.join(", ") ?? "");
  const [exceptions, setExceptions] = useState(fact?.exceptions.join(", ") ?? "");
  const [saving, setSaving] = useState(false); const [error, setError] = useState("");
  useEffect(() => { setKind(fact?.kind ?? "personality_tendency"); setValue(fact?.value ?? ""); setConditions(fact?.conditions.join(", ") ?? ""); setExceptions(fact?.exceptions.join(", ") ?? ""); }, [fact]);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setError("");
    try { const response = await fetch(`/api/profiles/${participantId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ factId: fact?.id, kind, value, conditions: conditions.split(",").map((item) => item.trim()).filter(Boolean), exceptions: exceptions.split(",").map((item) => item.trim()).filter(Boolean), action: "edit" }) });
      if (!response.ok) throw new Error("저장하지 못했어요. 잠시 후 다시 시도해 주세요."); onSaved?.(await response.json()); onClose?.();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "저장하지 못했어요."); } finally { setSaving(false); }
  }
  return <form className="editor-sheet" onSubmit={submit} aria-label="프로필 직접 수정">
    <div className="section-heading"><div><p className="eyebrow">직접 수정</p><h2>사실을 정확하게 고쳐요</h2></div>{onClose && <button type="button" className="icon-button" aria-label="편집 닫기" onClick={onClose}>×</button>}</div>
    <label>항목<select value={kind} onChange={(event) => setKind(event.target.value)}>{kinds.map((item) => <option value={item} key={item}>{kindLabels[item]}</option>)}</select></label>
    <label>관찰된 성향<textarea value={value} onChange={(event) => setValue(event.target.value)} required rows={3} /></label>
    <label>적용 조건 <input value={conditions} onChange={(event) => setConditions(event.target.value)} placeholder="쉼표로 구분" /></label>
    <label>예외 <input value={exceptions} onChange={(event) => setExceptions(event.target.value)} placeholder="쉼표로 구분" /></label>
    {error && <p className="form-error" role="alert">{error}</p>}<button className="primary-button" disabled={saving}>{saving ? "저장 중…" : "저장"}</button>
  </form>;
}
