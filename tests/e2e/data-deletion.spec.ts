import { expect, test } from "@playwright/test";

import {
  generateReplies,
  importAndAnalyze,
  login,
  openReplyForMinsu,
} from "./helpers";

test("deletes the room and every encrypted derived record", async ({ page }) => {
  await login(page);
  const { roomId } = await importAndAnalyze(page);
  await openReplyForMinsu(page);
  await generateReplies(page);
  await expect(page.getByTestId("reply-candidate")).toHaveCount(3);

  const before = await page.evaluate(async (id) => (
    fetch(`/api/health?roomId=${id}`).then((response) => response.json())
  ), roomId);
  expect(before.counts).toMatchObject({
    rooms: 1,
    messages: 3,
    chunks: 1,
    profileFacts: 2,
    replyRequests: 1,
    replyCandidates: 3,
  });

  await page.goto(`/rooms/${roomId}`);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "대화방 삭제" }).click();
  await expect(page).toHaveURL(/\/rooms$/u);
  await expect(page.getByRole("link", { name: "주말 약속 카카오톡 대화 열기" })).toHaveCount(0);

  const deletedPage = await page.goto(`/rooms/${roomId}`);
  expect(deletedPage?.status()).toBe(404);
  const after = await page.evaluate(async (id) => (
    fetch(`/api/health?roomId=${id}`).then((response) => response.json())
  ), roomId);
  expect(after.counts).toEqual({
    rooms: 0,
    messages: 0,
    chunks: 0,
    profileFacts: 0,
    replyRequests: 0,
    replyCandidates: 0,
  });
});
