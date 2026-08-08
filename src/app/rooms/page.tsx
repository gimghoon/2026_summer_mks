import { RoomsWorkspace } from "@/components/rooms-workspace";
import { requireSession } from "@/domain/auth/session";
import { listRoomViews } from "@/domain/rooms/room-read-service";

export default async function RoomsPage() {
  await requireSession();
  return <RoomsWorkspace initialRooms={await listRoomViews()} />;
}
