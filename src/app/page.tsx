import Link from "next/link";

export default function HomePage() {
  return (
    <main className="page-shell">
      <h1>내 카카오톡 답장 도우미</h1>
      <p>대화 맥락을 기억하고 여자어 답장 세 개를 추천합니다.</p>
      <Link href="/rooms">대화방 열기</Link>
    </main>
  );
}
