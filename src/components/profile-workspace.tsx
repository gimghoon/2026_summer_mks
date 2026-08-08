"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { BottomNav } from "@/components/bottom-nav";
import { ProfileCard, type ProfileFact } from "@/components/profile-card";
import { ProfileCorrectionChat } from "@/components/profile-correction-chat";
import { ProfileEditor } from "@/components/profile-editor";

export function ProfileWorkspace({ roomId, participantId, relationship }: { roomId: string; participantId: string; relationship: "female_friend" | "girlfriend" }) {
  const [facts, setFacts] = useState<ProfileFact[]>([]); const [selected, setSelected] = useState<ProfileFact | undefined>(); const [editorOpen, setEditorOpen] = useState(false); const [loading, setLoading] = useState(true); const [error, setError] = useState("");
  async function load() { setLoading(true); setError(""); try { const response = await fetch(`/api/profiles/${participantId}?roomId=${encodeURIComponent(roomId)}`); if (!response.ok) throw new Error("프로필을 불러오지 못했어요."); setFacts((await response.json()).facts ?? []); } catch (caught) { setError(caught instanceof Error ? caught.message : "프로필을 불러오지 못했어요."); } finally { setLoading(false); } }
  useEffect(() => { void load(); }, [participantId, roomId]);
  function upsert(fact: ProfileFact) { setFacts((current) => { const index = current.findIndex((item) => item.id === fact.id); return index < 0 ? [fact, ...current] : current.map((item) => item.id === fact.id ? fact : item); }); }
  return <main className="mobile-page"><header className="subpage-header"><Link href={`/rooms/${roomId}`} aria-label="대화방으로">‹</Link><div><p className="eyebrow">프로필 검수</p><h1>추정은 같이 확인해요</h1></div></header><section className="profile-intro"><p>AI가 본 대화 속 특징이에요. 맞는 사실은 잠그고, 아닌 부분은 직접 고치거나 말로 설명해 주세요.</p><Link className="primary-button" href={`/rooms/${roomId}/reply?participantId=${participantId}&relationship=${relationship}`}>답장 만들기</Link></section>{loading && <p className="loading" role="status">프로필을 불러오는 중…</p>}{error && <p className="form-error" role="alert">{error}</p>}{!loading && !error && <section className="profile-list" aria-label="분석된 프로필 사실"><div className="section-heading"><div><p className="eyebrow">분석 결과</p><h2>확인할 항목 {facts.length}개</h2></div><button className="text-button" onClick={() => { setSelected(undefined); setEditorOpen(true); }}>새 항목 추가</button></div>{facts.length ? facts.map((fact) => <ProfileCard fact={fact} key={fact.id} onEdit={(item) => { setSelected(item); setEditorOpen(true); }} />) : <div className="empty-state"><h3>아직 추정된 항목이 없어요</h3><p>직접 추가하거나 AI에게 설명해서 첫 프로필을 만들어 보세요.</p></div>}</section>}{editorOpen && <ProfileEditor roomId={roomId} participantId={participantId} fact={selected} onClose={() => { setSelected(undefined); setEditorOpen(false); }} onSaved={upsert} />}<ProfileCorrectionChat roomId={roomId} participantId={participantId} onConfirmed={load} /><BottomNav /></main>;
}
