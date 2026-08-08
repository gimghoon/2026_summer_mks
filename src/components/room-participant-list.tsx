import Link from "next/link";
import type { RoomView } from "@/domain/rooms/room-read-types";

export function RoomParticipantList({ room }: { room: RoomView }) {
  const people = room.participants.filter((participant) => !participant.isSelf);
  if (!people.length) return <div className="empty-state"><h2>상대방을 찾지 못했어요</h2><p>다시 가져오기에서 내 이름을 확인해 주세요.</p></div>;
  return <section className="participant-list" aria-label="친구 프로필"><p className="eyebrow">1 · 상대 프로필</p><h2>누구의 말투를 먼저 볼까요?</h2><p className="muted">답장을 만들기 전에 상대의 특징을 한 번 확인할 수 있어요.</p>{people.map((person) => <article className="participant-card" key={person.id}><div><span aria-hidden="true">◒</span><div><h3>{person.name}</h3><p>{person.relationshipStyle === "girlfriend" ? "여자친구 모드" : "여자 친구 모드"}</p></div></div><div><Link className="text-button" href={`/rooms/${room.id}/profiles/${person.id}`} aria-label={`${person.name} 프로필`}>프로필</Link><Link className="mini-primary" href={`/rooms/${room.id}/reply?participantId=${person.id}&relationship=${person.relationshipStyle ?? "female_friend"}`} aria-label={`${person.name} 답장 만들기`}>답장</Link></div></article>)}</section>;
}
