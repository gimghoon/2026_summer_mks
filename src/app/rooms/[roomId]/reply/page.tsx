"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { BottomNav } from "@/components/bottom-nav";
import { ReplyComposer } from "@/components/reply-composer";

export default function ReplyPage() {
  const { roomId } = useParams<{ roomId: string }>(); const params = useSearchParams(); const participantId = params.get("participantId") ?? ""; const relationship = params.get("relationship") === "girlfriend" ? "girlfriend" : "female_friend";
  return <main className="mobile-page"><header className="subpage-header"><Link href={`/rooms/${roomId}`} aria-label="대화방으로">‹</Link><div><p className="eyebrow">2 · 답장 만들기</p><h1>이번 대화의 마음</h1></div></header>{participantId ? <ReplyComposer roomId={roomId} participantId={participantId} initialRelationship={relationship} defaultIndirectness={3} /> : <section className="empty-state"><h2>상대 프로필을 먼저 선택해 주세요</h2><p>대화방에서 상대 이름을 선택한 뒤 답장 만들기를 눌러 주세요.</p><Link href={`/rooms/${roomId}`} className="primary-button">대화방으로 돌아가기</Link></section>}<BottomNav /></main>;
}
