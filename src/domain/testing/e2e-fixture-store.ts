import { randomUUID } from "node:crypto";

import type { ProfileFactView } from "@/domain/profiles/profile-service";
import type { ReplyCandidate } from "@/domain/replies/reply-service";
import { NO_PERSONAL_CONTEXT_BASIS } from "@/domain/replies/reply-evidence";
import type { RoomView } from "@/domain/rooms/room-read-types";
import { decryptJson, encryptJson } from "@/domain/crypto/encrypted-json";
import { parseKakaoExport } from "@/domain/kakao/parser";

type FixtureParticipant = {
  id: string;
  encryptedName: string;
  isSelf: boolean;
  relationshipStyle: "female_friend" | "girlfriend" | null;
};

type FixtureFact = Omit<ProfileFactView, "value" | "conditions" | "exceptions" | "evidenceTurnIds"> & {
  encryptedValue: string;
  encryptedConditions: string;
  encryptedExceptions: string;
  encryptedEvidenceTurnIds: string;
};

type FixtureProposal = {
  id: string;
  participantId: string;
  encryptedOldValue: string | null;
  encryptedNewValue: string;
  encryptedConditions: string;
  encryptedExceptions: string;
};

type FixtureReplyRequest = {
  roomId: string;
  participantId: string;
  encryptedPastedConversation: string;
  encryptedSituation: string;
  encryptedIntent: string;
  encryptedCandidates: string[];
};

type FixtureRoom = {
  id: string;
  encryptedTitle: string;
  updatedAt: string;
  participants: FixtureParticipant[];
  encryptedMessages: string[];
  encryptedChunks: string[];
  encryptedMemory: string | null;
  facts: FixtureFact[];
  proposals: FixtureProposal[];
  replyRequests: FixtureReplyRequest[];
};

type FixtureState = { rooms: Map<string, FixtureRoom> };

const fixtureStateSymbol = Symbol.for("private-reply-assistant.e2e-fixture-state");

function state(): FixtureState {
  const fixtureGlobal = globalThis as typeof globalThis & { [fixtureStateSymbol]?: FixtureState };
  fixtureGlobal[fixtureStateSymbol] ??= { rooms: new Map() };
  return fixtureGlobal[fixtureStateSymbol];
}

/**
 * The browser fixture adapter is deliberately unavailable in production. It
 * lets Playwright exercise the real UI and HTTP boundaries without a live
 * PostgreSQL or model-provider dependency.
 */
export function fixtureModeEnabled(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.E2E_FIXTURE_MODE === "1";
}

function roomView(room: FixtureRoom): RoomView {
  return {
    id: room.id,
    title: decryptJson<string>(room.encryptedTitle),
    updatedAt: room.updatedAt,
    analysisStatus: room.encryptedMemory && room.encryptedChunks.length > 0 ? "ready" : "needs_analysis",
    participants: room.participants.map((participant) => ({
      id: participant.id,
      name: decryptJson<string>(participant.encryptedName),
      isSelf: participant.isSelf,
      relationshipStyle: participant.relationshipStyle,
    })),
  };
}

function factView(fact: FixtureFact): ProfileFactView {
  return {
    id: fact.id,
    participantId: fact.participantId,
    kind: fact.kind,
    value: decryptJson<string>(fact.encryptedValue),
    conditions: decryptJson<string[]>(fact.encryptedConditions),
    exceptions: decryptJson<string[]>(fact.encryptedExceptions),
    confidence: fact.confidence,
    source: fact.source,
    locked: fact.locked,
    evidenceTurnIds: decryptJson<string[]>(fact.encryptedEvidenceTurnIds),
  };
}

export function importFixtureRoom(input: { title: string; selfName: string; rawText: string; existingRoomId?: string }) {
  const parsed = parseKakaoExport(input.rawText);
  if (input.existingRoomId) {
    const room = state().rooms.get(input.existingRoomId);
    if (!room) throw new Error("Room not found");
    const existingNames = new Set(room.participants.map((participant) => (
      decryptJson<string>(participant.encryptedName)
    )));
    for (const name of new Set([...parsed.participants, input.selfName])) {
      if (existingNames.has(name)) continue;
      room.participants.push({
        id: randomUUID(),
        encryptedName: encryptJson(name),
        isSelf: name === input.selfName,
        relationshipStyle: name === input.selfName ? null : "female_friend",
      });
    }
    const existingFingerprints = new Set(room.encryptedMessages.map((encrypted) => (
      decryptJson<{ sourceFingerprint: string }>(encrypted).sourceFingerprint
    )));
    const inserted = parsed.messages.filter((message) => !existingFingerprints.has(message.sourceFingerprint));
    room.encryptedMessages.push(...inserted.map((message) => encryptJson({
      speaker: message.speaker,
      kind: message.kind,
      text: message.text,
      sourceFingerprint: message.sourceFingerprint,
    })));
    if (inserted.length > 0) room.encryptedChunks = [];
    room.updatedAt = new Date().toISOString();
    return {
      roomId: room.id,
      insertedMessages: inserted.length,
      duplicateMessages: parsed.messages.length - inserted.length,
      unparsedLines: parsed.unparsedLines,
    };
  }
  const roomId = randomUUID();
  const names = [...new Set([...parsed.participants, input.selfName])];
  const room: FixtureRoom = {
    id: roomId,
    encryptedTitle: encryptJson(input.title),
    updatedAt: new Date().toISOString(),
    participants: names.map((name) => ({
      id: randomUUID(),
      encryptedName: encryptJson(name),
      isSelf: name === input.selfName,
      relationshipStyle: name === input.selfName ? null : "female_friend",
    })),
    encryptedMessages: parsed.messages.map((message) => encryptJson({
      speaker: message.speaker,
      kind: message.kind,
      text: message.text,
      sourceFingerprint: message.sourceFingerprint,
    })),
    encryptedChunks: [],
    encryptedMemory: null,
    facts: [],
    proposals: [],
    replyRequests: [],
  };
  state().rooms.set(roomId, room);
  return {
    roomId,
    insertedMessages: parsed.messages.length,
    duplicateMessages: 0,
    unparsedLines: parsed.unparsedLines,
  };
}

export function listFixtureRooms(): RoomView[] {
  return [...state().rooms.values()].map(roomView);
}

export function getFixtureRoom(roomId: string): RoomView | null {
  const room = state().rooms.get(roomId);
  return room ? roomView(room) : null;
}

export function analyzeFixtureRoom(roomId: string): { updatedChunks: number } | null {
  const room = state().rooms.get(roomId);
  if (!room) return null;
  room.encryptedChunks = [encryptJson({ analysisComplete: true, summary: "친근한 일상 대화" })];
  room.encryptedMemory = encryptJson({ version: 1, summary: "친근하게 농담을 주고받는 대화방" });
  if (room.facts.length === 0) {
    room.facts.push(...room.participants.filter((entry) => !entry.isSelf).map((participant) => ({
      id: randomUUID(),
      participantId: participant.id,
      kind: "personality_tendency" as const,
      encryptedValue: encryptJson("장난이 많고 편하게 대화함"),
      encryptedConditions: encryptJson(["친한 사이"]),
      encryptedExceptions: encryptJson([]),
      encryptedEvidenceTurnIds: encryptJson(["fixture-turn-1"]),
      confidence: 0.82,
      source: "ai_inference" as const,
      locked: false,
    })));
  }
  room.updatedAt = new Date().toISOString();
  return { updatedChunks: 1 };
}

export function fixtureParticipantBelongsToRoom(roomId: string, participantId: string): boolean {
  return state().rooms.get(roomId)?.participants.some((participant) => participant.id === participantId) ?? false;
}

export function listFixtureProfileFacts(participantId: string): ProfileFactView[] {
  return [...state().rooms.values()].flatMap((room) => room.facts)
    .filter((fact) => fact.participantId === participantId)
    .map(factView);
}

export function editFixtureProfileFact(input: {
  participantId: string;
  factId?: string;
  kind: ProfileFactView["kind"];
  value: string;
  conditions: string[];
  exceptions: string[];
}): ProfileFactView {
  const room = [...state().rooms.values()].find((entry) => (
    entry.participants.some((participant) => participant.id === input.participantId)
  ));
  if (!room) throw new Error("Fixture participant not found");
  let fact = input.factId ? room.facts.find((entry) => entry.id === input.factId) : undefined;
  if (!fact) {
    fact = {
      id: randomUUID(),
      participantId: input.participantId,
      kind: input.kind,
      encryptedValue: encryptJson(input.value),
      encryptedConditions: encryptJson(input.conditions),
      encryptedExceptions: encryptJson(input.exceptions),
      encryptedEvidenceTurnIds: encryptJson([]),
      confidence: 1,
      source: "user_edited",
      locked: true,
    };
    room.facts.push(fact);
  } else {
    fact.kind = input.kind;
    fact.encryptedValue = encryptJson(input.value);
    fact.encryptedConditions = encryptJson(input.conditions);
    fact.encryptedExceptions = encryptJson(input.exceptions);
    fact.confidence = 1;
    fact.source = "user_edited";
    fact.locked = true;
  }
  return factView(fact);
}

export function proposeFixtureCorrection(participantId: string, userExplanation: string) {
  const room = [...state().rooms.values()].find((entry) => (
    entry.participants.some((participant) => participant.id === participantId)
  ));
  if (!room) throw new Error("Fixture participant not found");
  const existing = room.facts.find((fact) => fact.participantId === participantId);
  const proposal: FixtureProposal = {
    id: randomUUID(),
    participantId,
    encryptedOldValue: existing?.encryptedValue ?? null,
    encryptedNewValue: encryptJson(userExplanation),
    encryptedConditions: encryptJson(["사용자가 설명한 상황"]),
    encryptedExceptions: encryptJson([]),
  };
  room.proposals.push(proposal);
  return {
    proposalId: proposal.id,
    participantId,
    factKind: existing?.kind ?? "personality_tendency",
    oldValue: proposal.encryptedOldValue ? decryptJson<string>(proposal.encryptedOldValue) : null,
    newValue: decryptJson<string>(proposal.encryptedNewValue),
    conditions: decryptJson<string[]>(proposal.encryptedConditions),
    exceptions: decryptJson<string[]>(proposal.encryptedExceptions),
  };
}

export function confirmFixtureCorrection(participantId: string, proposalId: string): ProfileFactView {
  const room = [...state().rooms.values()].find((entry) => entry.proposals.some((proposal) => (
    proposal.id === proposalId && proposal.participantId === participantId
  )));
  const proposal = room?.proposals.find((entry) => entry.id === proposalId);
  if (!room || !proposal) throw new Error("Fixture proposal not found");
  room.proposals = room.proposals.filter((entry) => entry.id !== proposalId);
  return editFixtureProfileFact({
    participantId,
    kind: "personality_tendency",
    value: decryptJson<string>(proposal.encryptedNewValue),
    conditions: decryptJson<string[]>(proposal.encryptedConditions),
    exceptions: decryptJson<string[]>(proposal.encryptedExceptions),
  });
}

const fixtureCandidates: [ReplyCandidate, ReplyCandidate, ReplyCandidate] = [
  { strategy: "relationship_soft", text: "다음에는 늦을 것 같으면 살짝만 알려줘 ㅎㅎ", intentLabel: "관계를 부드럽게 유지", riskLabel: null, contextBasis: [NO_PERSONAL_CONTEXT_BASIS], warnings: [] },
  { strategy: "emotion_signal", text: "기다리면서 조금 아쉽긴 했어~", intentLabel: "서운함을 은근히 전달", riskLabel: "의도가 약하게 들릴 수 있어요", contextBasis: [NO_PERSONAL_CONTEXT_BASIS], warnings: [] },
  { strategy: "clearer_request", text: "다음부터 늦을 때는 미리 한마디 부탁해", intentLabel: "기대 행동을 분명히 전달", riskLabel: null, contextBasis: [NO_PERSONAL_CONTEXT_BASIS], warnings: [] },
];

export function generateFixtureReplies(input: {
  roomId: string;
  participantId: string;
  pastedConversation: string;
  situation: string;
  intent: string;
}): { kind: "clarification_required"; question: string } | { kind: "replies"; candidates: typeof fixtureCandidates } {
  if (input.situation.includes("맥락이 부족해") && !input.situation.includes("추가 설명:")) {
    return { kind: "clarification_required", question: "어떤 약속 때문에 서운한지 한 가지만 알려줄래요?" };
  }
  const room = state().rooms.get(input.roomId);
  if (!room || !fixtureParticipantBelongsToRoom(input.roomId, input.participantId)) {
    throw new Error("Fixture room participant not found");
  }
  room.replyRequests.push({
    roomId: input.roomId,
    participantId: input.participantId,
    encryptedPastedConversation: encryptJson(input.pastedConversation),
    encryptedSituation: encryptJson(input.situation),
    encryptedIntent: encryptJson(input.intent),
    encryptedCandidates: fixtureCandidates.map((candidate) => encryptJson(candidate)),
  });
  return { kind: "replies", candidates: fixtureCandidates };
}

export function deleteFixtureRoom(roomId: string): boolean {
  return state().rooms.delete(roomId);
}

export function fixtureRoomCounts(roomId: string) {
  const room = state().rooms.get(roomId);
  if (!room) {
    return { rooms: 0, messages: 0, chunks: 0, profileFacts: 0, replyRequests: 0, replyCandidates: 0 };
  }
  return {
    rooms: 1,
    messages: room.encryptedMessages.length,
    chunks: room.encryptedChunks.length,
    profileFacts: room.facts.length,
    replyRequests: room.replyRequests.length,
    replyCandidates: room.replyRequests.reduce((total, request) => total + request.encryptedCandidates.length, 0),
  };
}

export function fixtureStoredPayloads(roomId: string): string[] {
  const room = state().rooms.get(roomId);
  if (!room) return [];
  return [
    room.encryptedTitle,
    ...room.participants.map((participant) => participant.encryptedName),
    ...room.encryptedMessages,
    ...room.encryptedChunks,
    ...(room.encryptedMemory ? [room.encryptedMemory] : []),
    ...room.facts.flatMap((fact) => [
      fact.encryptedValue,
      fact.encryptedConditions,
      fact.encryptedExceptions,
      fact.encryptedEvidenceTurnIds,
    ]),
    ...room.replyRequests.flatMap((request) => [
      request.encryptedPastedConversation,
      request.encryptedSituation,
      request.encryptedIntent,
      ...request.encryptedCandidates,
    ]),
  ];
}
