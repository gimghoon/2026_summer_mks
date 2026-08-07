export default function LoginPage() {
  return (
    <main className="page-shell">
      <h1>로그인</h1>
      <p>개인 답장 도우미 비밀번호를 입력하세요.</p>
      <form action="/api/session" method="post">
        <label htmlFor="password">비밀번호</label>
        <input
          autoComplete="current-password"
          id="password"
          name="password"
          required
          type="password"
        />
        <button type="submit">로그인</button>
      </form>
    </main>
  );
}
