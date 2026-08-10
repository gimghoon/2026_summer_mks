"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { AnalysisProgress } from "@/domain/memory/analysis-progress";
import type { RoomView } from "@/domain/rooms/room-read-types";

type Props = { room: RoomView; pollIntervalMs?: number };

function stageCopy(progress: AnalysisProgress): string {
  if (progress.status === "failed") return "분석을 마치지 못했어요. 다시 시도해 주세요.";
  if (progress.stage === "hierarchy") return "대화방 맥락을 종합하는 중이에요";
  if (progress.stage === "profiles") return "친구별 특징을 정리하는 중이에요";
  if (progress.stage === "complete") return "분석 완료";
  return `청크 ${progress.completedChunks}/${progress.totalChunks} 분석 완료`;
}

export function RoomAnalysisActions({ room, pollIntervalMs = 1_000 }: Props) {
  const router = useRouter();
  const refreshed = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<AnalysisProgress | null>(null);

  const loadProgress = useCallback(async () => {
    const response = await fetch(`/api/rooms/${room.id}/analysis`);
    if (!response.ok) return null;
    const next = await response.json() as AnalysisProgress;
    setProgress(next);
    return next;
  }, [room.id]);

  useEffect(() => {
    if (room.analysisStatus !== "ready") void loadProgress();
  }, [loadProgress, room.analysisStatus]);

  useEffect(() => {
    const shouldPoll = busy || progress?.status === "pending"
      || progress?.status === "analyzing" || progress?.status === "finalizing";
    if (!shouldPoll) return;
    const timer = window.setInterval(() => { void loadProgress(); }, pollIntervalMs);
    return () => window.clearInterval(timer);
  }, [busy, loadProgress, pollIntervalMs, progress?.status]);

  useEffect(() => {
    if (progress?.status === "ready" && !refreshed.current) {
      refreshed.current = true;
      router.refresh();
    }
  }, [progress?.status, router]);

  if (room.analysisStatus === "ready" || progress?.status === "ready") {
    return <p className="copy-notice" role="status">분석 완료 · 프로필과 답장을 만들 수 있어요.</p>;
  }

  async function retry() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/rooms/${room.id}/analysis`, { method: "POST" });
      if (!response.ok) throw new Error("분석을 다시 시작하지 못했어요.");
      await loadProgress();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "분석을 다시 시작하지 못했어요.");
    } finally {
      setBusy(false);
    }
  }

  const percentage = progress && progress.totalChunks > 0
    ? Math.floor((progress.completedChunks / progress.totalChunks) * 100)
    : 0;
  const serverBusy = progress?.status === "analyzing" || progress?.status === "finalizing";
  const analysisBusy = busy || serverBusy;
  return (
    <section className="upload-panel">
      <p className="eyebrow">{progress?.status === "failed" ? "분석 중단" : "대화 분석"}</p>
      <h2>{progress ? stageCopy(progress) : "분석 상태를 확인하는 중이에요"}</h2>
      {progress?.stage === "chunks" && progress.totalChunks > 0 && (
        <div
          className="progress-track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percentage}
          aria-label="대화 청크 분석 진행률"
        >
          <span style={{ width: `${percentage}%` }} />
        </div>
      )}
      <p className="muted">중단되어도 완료한 청크 다음부터 다시 이어가요.</p>
      <button className="primary-button" type="button" disabled={analysisBusy} onClick={retry}>
        {analysisBusy ? "분석 중…" : "분석 다시 시도"}
      </button>
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  );
}
