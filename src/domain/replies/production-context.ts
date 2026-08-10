import type { RelationshipStyle } from "@/db/schema";
import type { ModelGateway } from "@/domain/models/gateway";
import { selectCurrentContext, type DecryptedTurn } from "@/domain/replies/context-expander";
import { createSubmittedContextJudge } from "@/domain/replies/reply-production-policy";
import type {
  GenerateRepliesCommand,
  ParticipantProfileContext,
  ReplyGenerationContext,
} from "@/domain/replies/reply-service";
import { VectorContextRepository } from "@/domain/retrieval/vector-context-repository";

export type ProductionRoomParticipant = {
  id: string;
  name: string;
  isSelf: boolean;
};

export type ProductionChunkContext = {
  chunkId: string;
  roomId: string;
  startedAt: Date;
  endedAt: Date;
  embedding: number[];
  summary: string;
  emotions: string[];
  relationshipSignals: string[];
  topicTags: string[];
  eventTypes: string[];
  turns: DecryptedTurn[];
};

export type ProductionContextSnapshot = {
  roomParticipants: ProductionRoomParticipant[];
  chunks: ProductionChunkContext[];
  roomMemory: string | null;
  participantProfiles: ParticipantProfileContext[];
};

function normalizedName(name: string): string {
  return name.normalize("NFKC").trim().toLocaleLowerCase();
}

function hasExplicitParticipantReference(
  command: Pick<GenerateRepliesCommand, "situation" | "intent">,
  participants: ProductionRoomParticipant[],
): boolean {
  const framing = normalizedName(`${command.situation}\n${command.intent}`);
  return participants.some((participant) => {
    const name = normalizedName(participant.name);
    return name.length >= 2 && framing.includes(name);
  });
}

function submittedSpeakerId(
  label: string,
  participants: ProductionRoomParticipant[],
  fallbackParticipantId: string,
): string {
  const normalized = normalizedName(label);
  const exact = participants.find((participant) => normalizedName(participant.name) === normalized);
  if (exact) return exact.id;
  if (/^(?:나|내|본인|me)$/iu.test(normalized)) {
    return participants.find((participant) => participant.isSelf)?.id ?? fallbackParticipantId;
  }
  return `submitted-speaker:${normalized}`;
}

/** Parses common `speaker: message` pasted lines into adjacent speaker turns. */
export function parsePastedConversationTurns(
  pastedConversation: string,
  participants: ProductionRoomParticipant[],
  fallbackParticipantId: string,
  baseTime = new Date(),
): DecryptedTurn[] {
  const turns: DecryptedTurn[] = [];
  const lines = pastedConversation.replace(/\r\n?/g, "\n").split("\n");
  const speakerLine = /^\s*([^:\n]{1,80})\s*:\s*(.*)$/u;
  let current: DecryptedTurn | undefined;
  let ordinal = 0;

  for (const line of lines) {
    const match = line.match(speakerLine);
    if (match && match[2]?.trim()) {
      const speakerId = submittedSpeakerId(match[1]!, participants, fallbackParticipantId);
      if (!current || current.speakerId !== speakerId) {
        current = {
          id: `submitted-current-context-${ordinal}`,
          speakerId,
          startedAt: new Date(baseTime.getTime() + ordinal),
          messages: [],
        };
        turns.push(current);
        ordinal += 1;
      }
      current.messages.push({ kind: "text", text: match[2]!.trim() });
      continue;
    }
    if (!line.trim()) continue;
    if (!current) {
      current = {
        id: `submitted-current-context-${ordinal}`,
        speakerId: fallbackParticipantId,
        startedAt: new Date(baseTime.getTime() + ordinal),
        messages: [{ kind: "text", text: line.trim() }],
      };
      turns.push(current);
      ordinal += 1;
    } else {
      const lastMessage = current.messages.at(-1)!;
      lastMessage.text = `${lastMessage.text}\n${line}`;
    }
  }
  return turns;
}

function selectedContextPlaintext(turns: DecryptedTurn[]): string {
  return turns.flatMap((turn) => turn.messages.map((message) => message.text)).join("\n");
}

function candidateParticipantIds(chunk: ProductionChunkContext): string[] {
  return [...new Set(chunk.turns.map((turn) => turn.speakerId))];
}

function termsPresentInText(values: string[], text: string): string[] {
  const normalized = text.normalize("NFKC").toLocaleLowerCase();
  return [...new Set(values.filter((value) => (
    value.trim() && normalized.includes(value.normalize("NFKC").trim().toLocaleLowerCase())
  )))];
}

function nicknameProfileValues(profiles: ParticipantProfileContext[]): string[] {
  return profiles.filter((profile) => /nickname|alias|별명|호칭/u.test(profile.kind)).map((profile) => profile.value);
}

function sensitiveMetadata(chunk: ProductionChunkContext): string[] {
  return [...new Set([
    ...chunk.topicTags,
    ...chunk.eventTypes,
    ...chunk.relationshipSignals,
  ].filter((value) => /갈등|민감|금전|돈|안전|동의|거절|이별|질투|conflict|sensitive|money|safety|consent/iu.test(value)))];
}

function currentStoredChunk(snapshot: ProductionContextSnapshot): DecryptedTurn[] {
  const latest = [...snapshot.chunks].sort((left, right) => (
    right.endedAt.getTime() - left.endedAt.getTime() || right.chunkId.localeCompare(left.chunkId)
  ))[0];
  return latest?.turns ?? [];
}

export async function buildProductionReplyContext(
  command: GenerateRepliesCommand,
  relationship: RelationshipStyle,
  gateway: Pick<ModelGateway, "embed">,
  snapshot: ProductionContextSnapshot,
): Promise<ReplyGenerationContext> {
  const latestStoredTurns = currentStoredChunk(snapshot);
  const latestStoredTime = latestStoredTurns.at(-1)?.startedAt.getTime() ?? Date.now();
  const submittedTurns = parsePastedConversationTurns(
    command.pastedConversation,
    snapshot.roomParticipants,
    command.participantId,
    new Date(latestStoredTime + 1),
  );
  const combinedTurns = [...latestStoredTurns, ...submittedTurns];
  const currentContext = await selectCurrentContext({
    turns: combinedTurns,
    fullChunkStart: 0,
    judge: createSubmittedContextJudge(command),
    resolvedPersonReference: hasExplicitParticipantReference(command, snapshot.roomParticipants),
  });
  const selectedPlaintext = selectedContextPlaintext(currentContext.turns);
  const embeddingInput = [selectedPlaintext, command.situation, command.intent].filter(Boolean).join("\n");
  const [queryEmbedding] = await gateway.embed([embeddingInput]);

  const allTopicTags = snapshot.chunks.flatMap((chunk) => chunk.topicTags);
  const allEventTypes = snapshot.chunks.flatMap((chunk) => chunk.eventTypes);
  const participantNames = snapshot.roomParticipants.map((participant) => participant.name);
  const knownNicknames = [...participantNames, ...nicknameProfileValues(snapshot.participantProfiles)];
  const queryText = `${selectedPlaintext}\n${command.situation}\n${command.intent}`;
  const selectedParticipantIds = new Set(currentContext.turns.map((turn) => turn.speakerId));
  selectedParticipantIds.add(command.participantId);
  const groupConversation = snapshot.roomParticipants.filter((participant) => !participant.isSelf).length > 1;

  const contextRepository = new VectorContextRepository({
    listRankableChunks: async () => snapshot.chunks.map((chunk) => {
      const chunkText = `${chunk.summary}\n${selectedContextPlaintext(chunk.turns)}`;
      return {
        chunkId: chunk.chunkId,
        roomId: chunk.roomId,
        startedAt: chunk.startedAt,
        embedding: chunk.embedding,
        participantIds: candidateParticipantIds(chunk),
        topicTags: chunk.topicTags,
        eventTypes: chunk.eventTypes,
        nicknames: termsPresentInText(knownNicknames, chunkText),
        sensitiveTopics: sensitiveMetadata(chunk),
        decrypt: async () => ({ summary: chunk.summary, turns: chunk.turns }),
      };
    }),
  });
  const retrievedChunks = await contextRepository.findRelevant({
    roomId: command.roomId,
    participantIds: [...selectedParticipantIds],
    requiredParticipantIds: groupConversation ? [command.participantId] : [],
    queryEmbedding: queryEmbedding ?? [],
    topics: termsPresentInText(allTopicTags, queryText),
    eventTypes: termsPresentInText(allEventTypes, queryText),
    nicknames: termsPresentInText(knownNicknames, queryText),
    limit: 5,
  });

  return {
    relationship,
    currentContext,
    retrievedChunks,
    roomMemory: snapshot.roomMemory,
    participantProfiles: snapshot.participantProfiles,
    currentFacts: snapshot.participantProfiles.map((profile) => profile.value),
  };
}
