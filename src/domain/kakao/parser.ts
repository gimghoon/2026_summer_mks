import { createHash } from "node:crypto";

export type MessageKind = "text" | "media_event" | "deleted_event";

export type ParsedMessage = {
  sentAt: Date;
  speaker: string;
  text: string;
  sourceLine: number;
  kind: MessageKind;
};

export type ParsedMessageWithFingerprint = ParsedMessage & {
  sourceFingerprint: string;
};

export type ParseResult = {
  title: string;
  participants: string[];
  messages: ParsedMessage[];
  unparsedLines: Array<{ line: number; text: string }>;
};

export type ParsedKakaoExport = Omit<ParseResult, "messages"> & {
  messages: ParsedMessageWithFingerprint[];
};

const MESSAGE_LINE = /^(\d{4})(?:년|\.)\s*(\d{1,2})(?:월|\.)\s*(\d{1,2})(?:일|\.)\s*(오전|오후)\s*(\d{1,2}):(\d{2}),\s*(.+?)\s*:\s?(.*)$/;
const SAVED_DATE_LINE = /^저장한 날짜\s*:/;
const DIVIDER_LINE = /^[-=]{3,}\s*$/;
const MEDIA_PLACEHOLDER = /^\[?(?:사진|동영상|파일|음성메시지|이모티콘|앨범|지도|연락처|선물)\]?$/;
const DELETED_PLACEHOLDER = /^(?:삭제된 메시지입니다\.?|메시지가 삭제되었습니다\.?)$/;

function sourceFingerprint(sentAt: Date, speaker: string, kind: MessageKind, text: string): string {
  const normalized = [sentAt.toISOString(), speaker.trim(), kind, text.replace(/\r\n?/g, "\n")].join("\u001f");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

function parseSentAt(parts: RegExpMatchArray): Date | null {
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const meridiem = parts[4];
  const sourceHour = Number(parts[5]);
  const minute = Number(parts[6]);
  if (
    !Number.isInteger(year)
    || month < 1 || month > 12
    || day < 1 || day > 31
    || sourceHour < 1 || sourceHour > 12
    || minute < 0 || minute > 59
  ) return null;

  let hour = sourceHour % 12;
  if (meridiem === "오후") hour += 12;
  const calendarDate = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (
    calendarDate.getUTCFullYear() !== year
    || calendarDate.getUTCMonth() !== month - 1
    || calendarDate.getUTCDate() !== day
  ) return null;
  // KakaoTalk's date-based export has no offset; it is a Korea local timestamp.
  return new Date(calendarDate.getTime() - 9 * 60 * 60 * 1000);
}

function messageKind(text: string): MessageKind {
  const trimmed = text.trim();
  if (DELETED_PLACEHOLDER.test(trimmed)) return "deleted_event";
  if (MEDIA_PLACEHOLDER.test(trimmed)) return "media_event";
  return "text";
}

function isMalformedTimestampLine(line: string): boolean {
  return /^\d{4}(?:년|\.)/.test(line);
}

/** Parses the two date-based KakaoTalk text-export formats used by current clients. */
export function parseKakaoExport(input: string): ParsedKakaoExport {
  const lines = input.replace(/^\uFEFF/, "").split(/\r?\n/);
  const messages: ParsedMessageWithFingerprint[] = [];
  const unparsedLines: Array<{ line: number; text: string }> = [];
  const participants = new Set<string>();
  let title = "";
  let currentMessage: ParsedMessageWithFingerprint | undefined;

  for (const [index, line] of lines.entries()) {
    const sourceLine = index + 1;
    if (index === 0 && line.trim()) {
      title = line.trim();
      continue;
    }
    if (!line.trim() || SAVED_DATE_LINE.test(line) || DIVIDER_LINE.test(line)) continue;

    const match = line.match(MESSAGE_LINE);
    if (match) {
      const sentAt = parseSentAt(match);
      const speaker = match[7]?.trim();
      if (!sentAt || !speaker) {
        unparsedLines.push({ line: sourceLine, text: line });
        currentMessage = undefined;
        continue;
      }
      const text = match[8] ?? "";
      const kind = messageKind(text);
      currentMessage = {
        sentAt,
        speaker,
        text,
        sourceLine,
        kind,
        sourceFingerprint: sourceFingerprint(sentAt, speaker, kind, text),
      };
      messages.push(currentMessage);
      participants.add(speaker);
      continue;
    }

    if (isMalformedTimestampLine(line) || !currentMessage) {
      unparsedLines.push({ line: sourceLine, text: line });
      currentMessage = undefined;
      continue;
    }

    currentMessage.text = `${currentMessage.text}\n${line}`;
    currentMessage.kind = messageKind(currentMessage.text);
    currentMessage.sourceFingerprint = sourceFingerprint(
      currentMessage.sentAt,
      currentMessage.speaker,
      currentMessage.kind,
      currentMessage.text,
    );
  }

  return { title, participants: [...participants], messages, unparsedLines };
}
