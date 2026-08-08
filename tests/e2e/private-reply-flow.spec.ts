import { expect, test } from "@playwright/test";

import {
  generateReplies,
  importAndAnalyze,
  login,
} from "./helpers";

test("imports a room, corrects a profile, handles clarification, and copies one of three replies", async ({ page }) => {
  await login(page);
  const { roomId } = await importAndAnalyze(page);

  await page.getByRole("link", { name: "민수 프로필" }).click();
  await expect(page.getByRole("heading", { name: "분석 결과" })).toBeVisible();
  await page.getByRole("button", { name: "직접 수정" }).click();
  await page.getByLabel("관찰된 성향").fill("친한 사람에게만 장난이 많음");
  await page.getByRole("button", { name: "저장" }).click();
  await expect(page.getByText("친한 사람에게만 장난이 많음")).toBeVisible();

  await page.getByPlaceholder("예: 민수는 친한 사람에게만 저렇게 말해").fill("진지한 상황에서는 장난을 줄여");
  await page.getByRole("button", { name: "수정 제안 받기" }).click();
  await expect(page.getByText("진지한 상황에서는 장난을 줄여")).toBeVisible();
  await page.getByRole("button", { name: "이 내용으로 반영" }).click();
  await expect(page.getByText("진지한 상황에서는 장난을 줄여")).toBeVisible();

  await page.getByRole("link", { name: "답장 만들기" }).click();
  await generateReplies(page);
  await expect(page.getByTestId("reply-candidate")).toHaveCount(3);
  await page.getByTestId("reply-candidate").first().getByRole("button", { name: "복사" }).click();
  await expect(page.getByRole("status")).toContainText("답장을 복사했어요");

  await page.getByLabel("현재 상황").fill("맥락이 부족해");
  await page.getByRole("button", { name: "답장 3개 만들기" }).click();
  await expect(page.getByRole("heading", { name: /어떤 약속 때문에/u })).toBeVisible();
  await page.getByLabel("추가 설명").fill("주말 약속 시간에 또 늦었어");
  await page.getByRole("button", { name: "답장 다시 만들기" }).click();
  await expect(page.getByTestId("reply-candidate")).toHaveCount(3);

  const deletionStatus = await page.evaluate(async (id) => (
    fetch(`/api/rooms/${id}`, { method: "DELETE" }).then((response) => response.status)
  ), roomId);
  expect(deletionStatus).toBe(204);
});
