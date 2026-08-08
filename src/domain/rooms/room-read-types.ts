export type RoomParticipantView = {
  id: string;
  name: string;
  isSelf: boolean;
  relationshipStyle: "female_friend" | "girlfriend" | null;
};

export type RoomView = {
  id: string;
  title: string;
  updatedAt: string;
  participants: RoomParticipantView[];
  analysisStatus: "ready" | "needs_analysis";
};
