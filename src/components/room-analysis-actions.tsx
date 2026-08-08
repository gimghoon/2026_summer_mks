"use client";
import { useState } from "react";
import type { RoomView } from "@/domain/rooms/room-read-types";

export function RoomAnalysisActions({ room }: { room: RoomView }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  if (room.analysisStatus === "ready") return <p className="copy-notice" role="status">분석 완료 · 프로필과 답장을 만들 수 있어요.</p>;
  async function retry() { setBusy(true); setError(""); try { const response = await fetch(`/api/rooms/${room.id}/analysis`, { method: "POST" }); if (!response.ok) throw new Error("분석을 다시 시작하지 못했어요."); window.location.reload(); } catch (caught) { setError(caught instanceof Error ? caught.message : "분석을 다시 시작하지 못했어요."); setBusy(false); } }
  return <section className="upload-panel"><p className="eyebrow">분석 대기</p><h2>아직 검수가 준비되지 않았어요</h2><p className="muted">분석을 완료하면 프로필과 답장 기능이 열려요.</p><button className="primary-button" type="button" disabled={busy} onClick={retry}>{busy ? "분석 중…" : "분석 다시 시도"}</button>{error && <p className="form-error" role="alert">{error}</p>}</section>;
}
