import Link from "next/link";
import { notFound } from "next/navigation";
import { BottomNav } from "@/components/bottom-nav";
import { ImportProgress } from "@/components/import-progress";
import { RoomParticipantList } from "@/components/room-participant-list";
import { RoomDeleteButton } from "@/components/room-delete-button";
import { requireSession } from "@/domain/auth/session";
import { getRoomView } from "@/domain/rooms/room-read-service";

export default async function RoomPage({ params }: { params: Promise<{ roomId: string }> }) {
  await requireSession(); const { roomId } = await params; const room = await getRoomView(roomId); if (!room) notFound();
  return <main className="mobile-page"><header className="subpage-header"><Link href="/rooms" aria-label="대화방 목록으로">‹</Link><div><p className="eyebrow">대화방 검수</p><h1>{room.title}</h1></div></header><ImportProgress progress={100} /><RoomParticipantList room={room} /><section className="danger-zone"><p className="eyebrow">삭제</p><h2>대화방을 지울까요?</h2><p>원문과 분석된 맥락, 프로필, 답장 기록이 함께 삭제돼요.</p><RoomDeleteButton roomId={room.id} /></section><BottomNav /></main>;
}
