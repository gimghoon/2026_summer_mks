"use client";

export function ImportProgress({ progress, unparsedLines = [] }: { progress: number; unparsedLines?: Array<{ line: number; text: string }> }) {
  return (
    <section className="import-progress" aria-live="polite" aria-label="대화 파일 가져오기 상태">
      <div className="section-heading"><div><p className="eyebrow">대화 가져오기</p><h2>{progress < 100 ? "대화 파일을 읽는 중이에요" : "파일 가져오기가 끝났어요"}</h2></div><strong>{progress}%</strong></div>
      <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }} /></div>
      <p className="muted">확인할 줄을 검토한 다음 실제 대화 분석을 시작할 수 있어요.</p>
      {unparsedLines.length > 0 && <details className="line-review"><summary>확인할 줄 {unparsedLines.length}개</summary><ul>{unparsedLines.map((line) => <li key={line.line}><b>{line.line}줄</b> {line.text}</li>)}</ul></details>}
    </section>
  );
}
