import Link from "next/link";
import { BottomNav } from "@/components/bottom-nav";
import { requireSession } from "@/domain/auth/session";
import { listRoomViews } from "@/domain/rooms/room-read-service";

export default async function ProfilesPage() {
  await requireSession(); const rooms = await listRoomViews(); const people = rooms.flatMap((room) => room.participants.filter((person) => !person.isSelf).map((person) => ({ ...person, room })));
  return <main className="mobile-page"><header className="hero"><p className="eyebrow">친구 프로필</p><h1>대화 속 특징을<br />확인해요.</h1></header><section className="participant-list" aria-label="친구 프로필 목록">{people.length ? people.map(({ room, ...person }) => <article className="participant-card" key={person.id}><div><span aria-hidden="true">◒</span><div><h3>{person.name}</h3><p>{room.title}</p></div></div><Link className="mini-primary" href={`/rooms/${room.id}/profiles/${person.id}`} aria-label={`${person.name} 프로필`}>검수</Link></article>) : <div className="empty-state"><h2>아직 확인할 프로필이 없어요</h2><p>대화방을 가져오면 이곳에 상대 프로필이 모여요.</p></div>}</section><BottomNav /></main>;
}
