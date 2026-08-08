import { expect, type Page } from "@playwright/test";

export async function login(page: Page): Promise<void> {
  await page.goto("/rooms");
  await expect(page).toHaveURL(/\/login$/u);
  await page.getByLabel("비밀번호").fill("e2e-private-password");
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/$/u);
  await page.goto("/rooms");
  await expect(page.getByRole("heading", { name: /대화의 결을/u })).toBeVisible();
}

export async function importAndAnalyze(page: Page): Promise<{ roomId: string }> {
  await page.getByLabel("카카오톡 파일 업로드").setInputFiles("tests/fixtures/kakao/group-chat.txt");
  await page.getByLabel("내 이름").fill("지훈");
  await page.getByRole("button", { name: "파일 가져오기" }).click();
  await expect(page.getByRole("heading", { name: "가져오기 검토" })).toBeVisible();
  await page.getByRole("button", { name: "검토 후 분석 시작" }).click();
  await expect(page).toHaveURL(/\/rooms\/[0-9a-f-]+$/u);
  const roomId = new URL(page.url()).pathname.split("/").at(-1);
  if (!roomId) throw new Error("room id missing from analyzed-room URL");
  return { roomId };
}

export async function openReplyForMinsu(page: Page): Promise<void> {
  await page.getByRole("link", { name: "민수 프로필" }).click();
  await expect(page.getByRole("heading", { name: "추정은 같이 확인해요" })).toBeVisible();
  await page.getByRole("link", { name: "답장 만들기" }).click();
  await expect(page.getByRole("heading", { name: "이번 대화의 마음" })).toBeVisible();
}

export async function generateReplies(page: Page, situation = "또 늦어서 서운하지만 싸우고 싶지는 않아"): Promise<void> {
  await page.getByLabel("최근 대화").fill("민수: 미안 오늘도 조금 늦을 것 같아\n나: 알겠어");
  await page.getByLabel("현재 상황").fill(situation);
  await page.getByRole("button", { name: "답장 3개 만들기" }).click();
}
