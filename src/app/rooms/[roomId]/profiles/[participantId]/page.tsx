import { notFound } from "next/navigation";
import { ProfileWorkspace } from "@/components/profile-workspace";
import { requireSession } from "@/domain/auth/session";
import { getRoomView } from "@/domain/rooms/room-read-service";

export default async function ProfilePage({ params }: { params: Promise<{ roomId: string; participantId: string }> }) {
  await requireSession(); const { roomId, participantId } = await params; const room = await getRoomView(roomId);
  if (!room || !room.participants.some((person) => person.id === participantId && !person.isSelf)) notFound();
  return <ProfileWorkspace roomId={roomId} participantId={participantId} />;
}
