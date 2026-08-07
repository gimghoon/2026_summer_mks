import type { ParsedMessage } from "./parser";

export type ParsedTurn = {
  speaker: string;
  startedAt: Date;
  endedAt: Date;
  messages: ParsedMessage[];
};

export type TypedParsedTurn<T extends ParsedMessage> = {
  speaker: string;
  startedAt: Date;
  endedAt: Date;
  messages: T[];
};

/** Groups adjacent messages only; a later message from the same speaker starts a new turn after any reply. */
export function groupMessageTurns<T extends ParsedMessage>(messages: T[]): TypedParsedTurn<T>[] {
  const turns: TypedParsedTurn<T>[] = [];
  for (const message of messages) {
    const previous = turns.at(-1);
    if (previous && previous.speaker === message.speaker) {
      previous.messages.push(message);
      previous.endedAt = message.sentAt;
      continue;
    }
    turns.push({
      speaker: message.speaker,
      startedAt: message.sentAt,
      endedAt: message.sentAt,
      messages: [message],
    });
  }
  return turns;
}
