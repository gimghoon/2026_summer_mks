"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function RoomDeleteButton({ roomId }: { roomId: string }) {
  const router = useRouter(); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function remove() { if (!window.confirm("이 대화방과 분석된 프로필, 답장 기록을 모두 삭제할까요? 이 작업은 되돌릴 수 없어요.")) return; setBusy(true); setError(""); try { const response = await fetch(`/api/rooms/${roomId}`, { method: "DELETE" }); if (!response.ok) throw new Error("삭제하지 못했어요. 다시 시도해 주세요."); router.push("/rooms"); router.refresh(); } catch (caught) { setError(caught instanceof Error ? caught.message : "삭제하지 못했어요."); setBusy(false); } }
  return <><button type="button" className="danger-button" disabled={busy} onClick={remove}>{busy ? "삭제 중…" : "대화방 삭제"}</button>{error && <p className="form-error" role="alert">{error}</p>}</>;
}
