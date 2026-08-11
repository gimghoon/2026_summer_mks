import { expect, test } from "@playwright/test";

import {
  generateReplies,
} from "./helpers";
import { PERSONAL_CONTEXT_UNAVAILABLE_MESSAGE } from "../../src/domain/replies/required-personal-context";

const inferenceWarning = "AI가 추정한 개인 컨텍스트를 사용했어요. 실제 성향과 맞는지 확인해 주세요.";

function replyCards(page: import("@playwright/test").Page) {
  const workspace = page.getByRole("main");
  return workspace.getByRole("article").filter({
    has: page.getByRole("button", { name: "복사" }),
  });
}

async function importAndAnalyzeForPrivateFlow(page: import("@playwright/test").Page): Promise<string> {
  const workspace = page.getByRole("main");
  await expect(workspace.getByRole("heading", { name: "카카오톡 파일 가져오기" })).toBeVisible();
  await workspace.getByRole("textbox", { name: "내 이름" }).fill("지훈");
  await workspace.getByRole("button", { name: "카카오톡 파일 업로드" })
    .setInputFiles("tests/fixtures/kakao/group-chat.txt");
  await expect(workspace.getByRole("button", { name: "파일 가져오기" })).toBeEnabled();
  await workspace.getByRole("button", { name: "파일 가져오기" }).click();
  await expect(workspace.getByRole("heading", { name: "가져오기 검토" })).toBeVisible();
  await workspace.getByRole("button", { name: "검토 후 분석 시작" }).click();
  await expect(page.getByRole("heading", { name: "주말 약속 카카오톡 대화" })).toBeVisible();
  const roomId = new URL(page.url()).pathname.split("/").at(-1);
  if (!roomId) throw new Error("room id missing from analyzed-room URL");
  return roomId;
}

test("covers verified, inferred, unavailable, remembered mode, clarification, and copy flows", async ({ page }) => {
  await page.goto("/rooms");
  await page.getByLabel("비밀번호").fill("e2e-private-password");
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/rooms$/u);
  await page.goto("/rooms");
  await expect(page.getByRole("heading", { name: /대화의 결을/u })).toBeVisible();
  const roomId = await importAndAnalyzeForPrivateFlow(page);

  await page.getByRole("link", { name: "민수 프로필" }).click();
  await expect(page.getByRole("heading", { name: "추정은 같이 확인해요" })).toBeVisible();
  await page.getByRole("button", { name: "직접 수정" }).click();
  await page.getByRole("textbox", { name: "관찰된 성향", exact: true }).fill("진지한 상황에서는 장난을 줄임");
  await page.getByRole("button", { name: "저장" }).click();
  await expect(page.getByText("진지한 상황에서는 장난을 줄임")).toBeVisible();

  await page.getByPlaceholder("예: 민수는 친한 사람에게만 저렇게 말해").fill("약속이 틀어지면 농담 없이 진지하게 말해");
  await page.getByRole("button", { name: "수정 제안 받기" }).click();
  await expect(page.getByRole("status")).toContainText("약속이 틀어지면 농담 없이 진지하게 말해");
  await page.getByRole("button", { name: "이 내용으로 반영" }).click();
  await expect(page.getByRole("region", { name: "분석된 프로필 사실" }))
    .toContainText("약속이 틀어지면 농담 없이 진지하게 말해");

  await page.getByRole("link", { name: "답장 만들기" }).click();
  const replyWorkspace = page.getByRole("main");
  const requiredMode = replyWorkspace.getByRole("checkbox", { name: "개인 컨텍스트 강제 반영" });
  await requiredMode.check();
  await generateReplies(page);
  await expect(replyCards(page)).toHaveCount(3);
  await expect(replyCards(page).filter({ hasText: "부드럽게 관계 지키기" }))
    .toContainText("부드럽게 말하고 싶어. 다음에는 늦을 것 같으면 미리 알려주면 좋겠어.");
  await expect(replyCards(page).filter({ hasText: "은근히 눈치 주기" }))
    .toContainText("기다리는 동안 조금 서운했어. 다음에는 미리 알려주면 좋겠어.");
  await expect(replyCards(page).filter({ hasText: "조금 더 분명하게 말하기" }))
    .toContainText("다음부터 늦을 때는 꼭 미리 한마디 해줘.");
  for (const card of await replyCards(page).all()) await expect(card).not.toContainText(/[ㅎㅋ~]/u);
  await page.reload();
  await expect(page.getByRole("main").getByRole("checkbox", { name: "개인 컨텍스트 강제 반영" })).toBeChecked();
  await generateReplies(page);
  await replyCards(page).first().getByRole("button", { name: "복사" }).click();
  await expect(page.getByRole("status").filter({ hasText: "답장을 복사했어요" })).toBeVisible();

  await page.getByLabel("현재 상황").fill("맥락이 부족해");
  await page.getByRole("button", { name: "답장 3개 만들기" }).click();
  await expect(page.getByRole("heading", { name: /어떤 약속 때문에/u })).toBeVisible();
  await page.getByLabel("추가 설명").fill("주말 약속 시간에 또 늦었어");
  await page.getByRole("button", { name: "답장 다시 만들기" }).click();
  await expect(replyCards(page)).toHaveCount(3);

  await page.getByRole("link", { name: "대화방으로" }).click();
  await page.getByRole("link", { name: "서연 답장 만들기" }).click();
  await expect(page.getByRole("main").getByRole("checkbox", { name: "개인 컨텍스트 강제 반영" })).toBeChecked();
  await generateReplies(page);
  await expect(replyCards(page)).toHaveCount(3);
  for (const card of await replyCards(page).all()) {
    await expect(card.getByRole("list", { name: "답장 주의 사항" })).toContainText(inferenceWarning);
  }

  await page.getByRole("link", { name: "대화방으로" }).click();
  await page.getByRole("link", { name: "유나 답장 만들기" }).click();
  await expect(page.getByRole("main").getByRole("checkbox", { name: "개인 컨텍스트 강제 반영" })).toBeChecked();
  await generateReplies(page);
  const recovery = page.getByRole("main");
  await expect(recovery.getByRole("heading", { name: "프로필을 먼저 확인해 주세요" })).toBeVisible();
  await expect(recovery.getByText(PERSONAL_CONTEXT_UNAVAILABLE_MESSAGE, { exact: true })).toBeVisible();
  await recovery.getByRole("link", { name: "프로필 확인하기" }).click();
  await expect(page.getByRole("heading", { name: "추정은 같이 확인해요" })).toBeVisible();
  await expect(page.getByText("유나 프로필 검수", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "분석된 프로필 사실" }))
    .toContainText("아직 추정된 항목이 없어요");

  const deletionStatus = await page.evaluate(async (id) => (
    fetch(`/api/rooms/${id}`, { method: "DELETE" }).then((response) => response.status)
  ), roomId);
  expect(deletionStatus).toBe(204);
});
