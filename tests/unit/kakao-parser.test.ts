import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parseKakaoExport } from "@/domain/kakao/parser";
import { groupMessageTurns } from "@/domain/kakao/turns";

function fixture(name: string): string {
  return readFileSync(resolve(process.cwd(), "tests/fixtures/kakao", name), "utf8");
}

test("parses Korean timestamps and retains Kakao source-line positions", () => {
  const parsed = parseKakaoExport(fixture("one-to-one.txt"));

  expect(parsed.title).toBe("민수와 카카오톡 대화");
  expect(parsed.messages[0]).toMatchObject({
    speaker: "민수",
    text: "거의 다 왔어 ㅋㅋ",
    sourceLine: 3,
    sentAt: new Date("2026-08-07T00:01:00.000Z"),
  });
  expect(parsed.messages[2]).toMatchObject({
    text: "저녁은 같이 먹을래?\n메뉴는 네가 골라줘",
    sourceLine: 5,
  });
  expect(parsed.messages.map((message) => message.kind)).toEqual([
    "text", "text", "text", "media_event", "deleted_event",
  ]);
});

test("preserves unknown timestamp-shaped lines and produces stable fingerprints", () => {
  const raw = fixture("one-to-one.txt");
  const first = parseKakaoExport(raw);
  const second = parseKakaoExport(raw);

  expect(first.unparsedLines).toEqual([
    { line: 9, text: "2026년 8월 7일 아침 9:06, 민수 : 이 줄은 잘못된 형식이야" },
  ]);
  expect(first.messages.map((message) => message.sourceFingerprint)).toEqual(
    second.messages.map((message) => message.sourceFingerprint),
  );
  expect(first.messages[0]!.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
});

test("parses dot-delimited group exports and groups only consecutive speakers", () => {
  const parsed = parseKakaoExport(fixture("group-chat.txt"));
  const turns = groupMessageTurns(parseKakaoExport(fixture("one-to-one.txt")).messages);

  expect(parsed.participants).toEqual(["서연", "민수", "지훈"]);
  expect(parsed.messages[0]!.sentAt).toEqual(new Date("2026-08-07T04:01:00.000Z"));
  expect(turns.map((turn) => [turn.speaker, turn.messages.length])).toEqual([
    ["민수", 1], ["지훈", 1], ["민수", 3],
  ]);
});
