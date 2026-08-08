export type DecryptedTurn = {
  id: string;
  speakerId: string;
  startedAt: Date;
  messages: Array<{
    kind: "text" | "media_event" | "deleted_event";
    text: string;
  }>;
};

export type ContextQuery = {
  roomId: string;
  participantIds: string[];
  queryEmbedding: number[];
  topics: string[];
  eventTypes: string[];
  nicknames: string[];
  limit: 5;
};

export type RetrievedChunk = {
  chunkId: string;
  score: number;
  summary: string;
  turns: DecryptedTurn[];
};

/** A rankable chunk deliberately excludes decrypted conversation content. */
export type ContextChunkCandidate = {
  chunkId: string;
  roomId: string;
  startedAt: Date;
  embedding: number[];
  participantIds: string[];
  topicTags: string[];
  eventTypes: string[];
  nicknames: string[];
  sensitiveTopics: string[];
  decrypt: () => Promise<Pick<RetrievedChunk, "summary" | "turns">>;
};

/** Implementations should return rank metadata only; decrypt is deferred by the caller. */
export interface ContextChunkSource {
  listRankableChunks(roomId: string): Promise<ContextChunkCandidate[]>;
}

export interface ContextRepository {
  findRelevant(query: ContextQuery): Promise<RetrievedChunk[]>;
}
