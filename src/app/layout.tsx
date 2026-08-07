import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "내 카카오톡 답장 도우미",
  description: "대화 맥락을 기억하고 여자어 답장을 추천하는 개인용 도우미",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
