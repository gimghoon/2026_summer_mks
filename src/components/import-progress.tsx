"use client";

export function ImportProgress({ progress, unparsedLines = [] }: { progress: number; unparsedLines?: Array<{ line: number; text: string }> }) {
  return (
    <section className="import-progress" aria-live="polite" aria-label="대화 분석 진행 상태">
      <div className="section-heading"><div><p className="eyebrow">대화 가져오기</p><h2>{progress < 100 ? "대화 맥락을 읽는 중이에요" : "분석이 완료됐어요"}</h2></div><strong>{progress}%</strong></div>
      <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }} /></div>
      <p className="muted">중단되어도 완료한 단계부터 다시 이어갈 수 있어요.</p>
      {unparsedLines.length > 0 && <details className="line-review"><summary>확인할 줄 {unparsedLines.length}개</summary><ul>{unparsedLines.map((line) => <li key={line.line}><b>{line.line}줄</b> {line.text}</li>)}</ul></details>}
    </section>
  );
}
