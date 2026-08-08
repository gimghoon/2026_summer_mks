import Link from "next/link";

export type RoomCardData = {
  id: string;
  title: string;
  status: "analyzing" | "ready" | "needs_review";
  updatedAt: string;
  participantCount?: number;
};

const statusText = { analyzing: "분석 중", ready: "분석 완료", needs_review: "검수가 필요해요" } as const;

export function RoomCard({ room }: { room: RoomCardData }) {
  return (
    <article className="room-card">
      <div className="room-card__icon" aria-hidden="true">채</div>
      <div className="room-card__body">
        <div className="room-card__topline"><h2>{room.title}</h2><span className={`status status--${room.status}`}>{statusText[room.status]}</span></div>
        <p>{room.participantCount ? `${room.participantCount}명 참여` : "대화 내용을 확인해 주세요"} · {room.updatedAt}</p>
      </div>
      <Link className="room-card__link" href={`/rooms/${room.id}`} aria-label={`${room.title} 열기`}><span aria-hidden="true">›</span></Link>
    </article>
  );
}
