"use client";

import { useEffect, useState } from "react";
import { BottomNav } from "@/components/bottom-nav";

export default function SettingsPage() {
  const [level, setLevel] = useState<1 | 2 | 3 | 4 | 5>(3); const [saved, setSaved] = useState(false);
  useEffect(() => { const stored = window.localStorage.getItem("reply-default-indirectness"); if (stored && /^[1-5]$/.test(stored)) setLevel(Number(stored) as 1 | 2 | 3 | 4 | 5); }, []);
  function save() { window.localStorage.setItem("reply-default-indirectness", String(level)); setSaved(true); }
  return <main className="mobile-page"><header className="hero"><p className="eyebrow">설정</p><h1>내 기본 말투 강도</h1><p>이 브라우저에만 저장되며, 답장 화면에서 이번 요청에 한해 바꿀 수 있어요.</p></header><section className="upload-panel"><label className="intensity-control">여자어 기본 강도 <output>{level}</output><input type="range" min="1" max="5" value={level} aria-label="여자어 기본 강도" onChange={(event) => { setLevel(Number(event.target.value) as 1 | 2 | 3 | 4 | 5); setSaved(false); }} /><span>직접적</span><span>돌려 말하기</span></label><button type="button" className="primary-button" onClick={save}>기본 강도 저장</button>{saved && <p className="copy-notice" role="status">기본 강도를 저장했어요.</p>}</section><BottomNav /></main>;
}
