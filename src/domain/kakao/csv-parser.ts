export type CsvMessage = {
  sentAt: Date;
  speaker: string;
  text: string;
  sourceLine: number;
};

type CsvRecord = {
  fields: string[];
  sourceLine: number;
  text: string;
  malformed: boolean;
};

const CSV_HEADER = ["Date", "User", "Message"];
const CSV_DATE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

export function isKakaoCsv(input: string): boolean {
  return /^(?:Date,User,Message)(?:\r?\n|$)/.test(input);
}

function parseRecords(input: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = "";
  let text = "";
  let sourceLine = 1;
  let line = 1;
  let inQuotes = false;
  let quotedField = false;
  let afterQuote = false;
  let malformed = false;
  let hasRecordContent = false;

  const finishRecord = () => {
    fields.push(field);
    records.push({ fields, sourceLine, text, malformed });
    fields = [];
    field = "";
    text = "";
    sourceLine = line + 1;
    quotedField = false;
    afterQuote = false;
    malformed = false;
    hasRecordContent = false;
  };

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    const next = input[index + 1];

    if (inQuotes) {
      if (character === '"') {
        if (next === '"') {
          field += '"';
          text += '""';
          index += 1;
          continue;
        }
        inQuotes = false;
        afterQuote = true;
        text += character;
        continue;
      }
      if (character === "\r" && next === "\n") {
        field += "\n";
        text += "\r\n";
        line += 1;
        index += 1;
        continue;
      }
      if (character === "\n") {
        field += "\n";
        text += character;
        line += 1;
        continue;
      }
      field += character;
      text += character;
      continue;
    }

    if (character === ",") {
      if (afterQuote) afterQuote = false;
      fields.push(field);
      field = "";
      quotedField = false;
      text += character;
      hasRecordContent = true;
      continue;
    }

    if (character === "\r" && next === "\n") {
      finishRecord();
      line += 1;
      index += 1;
      continue;
    }

    if (character === "\n") {
      finishRecord();
      line += 1;
      continue;
    }

    if (afterQuote) malformed = true;
    if (character === '"') {
      if (field === "" && !quotedField) {
        inQuotes = true;
        quotedField = true;
      } else {
        malformed = true;
        field += character;
      }
    } else {
      field += character;
    }
    text += character;
    hasRecordContent = true;
  }

  if (inQuotes) malformed = true;
  if (hasRecordContent || fields.length > 0 || field.length > 0 || inQuotes) {
    fields.push(field);
    records.push({ fields, sourceLine, text, malformed });
  }

  return records;
}

function parseSentAt(input: string): Date | null {
  const match = input.match(CSV_DATE);
  if (!match) return null;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const sentAt = new Date(Date.UTC(year, month - 1, day, hour - 9, minute, second));
  const koreaLocal = new Date(sentAt.getTime() + 9 * 60 * 60 * 1000);

  if (
    koreaLocal.getUTCFullYear() !== year
    || koreaLocal.getUTCMonth() !== month - 1
    || koreaLocal.getUTCDate() !== day
    || koreaLocal.getUTCHours() !== hour
    || koreaLocal.getUTCMinutes() !== minute
    || koreaLocal.getUTCSeconds() !== second
  ) return null;

  return sentAt;
}

export function parseKakaoCsv(input: string): {
  messages: CsvMessage[];
  unparsedLines: Array<{ line: number; text: string }>;
} {
  const records = parseRecords(input);
  const messages: CsvMessage[] = [];
  const unparsedLines: Array<{ line: number; text: string }> = [];

  if (records.length === 0 || records[0]!.malformed || records[0]!.fields.length !== 3
    || records[0]!.fields.some((field, index) => field !== CSV_HEADER[index])) {
    return { messages, unparsedLines: records.map(({ sourceLine, text }) => ({ line: sourceLine, text })) };
  }

  for (const record of records.slice(1)) {
    const [date, speaker, text] = record.fields;
    const sentAt = !record.malformed && record.fields.length === 3 && date
      ? parseSentAt(date)
      : null;
    if (!sentAt || !speaker?.trim() || text === undefined) {
      unparsedLines.push({ line: record.sourceLine, text: record.text });
      continue;
    }
    messages.push({ sentAt, speaker: speaker.trim(), text, sourceLine: record.sourceLine });
  }

  return { messages, unparsedLines };
}
