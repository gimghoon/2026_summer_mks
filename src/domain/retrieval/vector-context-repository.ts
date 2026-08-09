import type {
  ContextChunkCandidate,
  ContextChunkSource,
  ContextQuery,
  ContextRepository,
  RetrievedChunk,
} from "@/domain/retrieval/context-repository";

type RankedCandidate = {
  candidate: ContextChunkCandidate;
  score: number;
};

const RECENCY_HALF_LIFE_DAYS = 180;
const SENSITIVE_TOPIC_PENALTY = 0.25;
const MIN_RELEVANCE_SCORE = 0.1;

function normalizedTerms(terms: string[]): Set<string> {
  return new Set(terms.map((term) => term.trim().toLocaleLowerCase()).filter(Boolean));
}

function overlapScore(values: string[], queryTerms: Set<string>): number {
  if (values.length === 0 || queryTerms.size === 0) return 0;
  const matches = values.filter((value) => queryTerms.has(value.trim().toLocaleLowerCase())).length;
  return matches / values.length;
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dotProduct = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    dotProduct += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dotProduct / Math.sqrt(leftMagnitude * rightMagnitude);
}

function recencyScore(startedAt: Date, now: Date): number {
  const ageInDays = Math.max(0, now.getTime() - startedAt.getTime()) / 86_400_000;
  return Math.exp((-Math.LN2 * ageInDays) / RECENCY_HALF_LIFE_DAYS);
}

function sensitiveTopicPenalty(candidate: ContextChunkCandidate, queryTerms: Set<string>): number {
  if (candidate.sensitiveTopics.length === 0) return 0;
  return overlapScore(candidate.sensitiveTopics, queryTerms) > 0 ? 0 : SENSITIVE_TOPIC_PENALTY;
}

function scoreCandidate(candidate: ContextChunkCandidate, query: ContextQuery, now: Date): number {
  const participantTerms = normalizedTerms(query.participantIds);
  const topicTerms = normalizedTerms(query.topics);
  const eventTerms = normalizedTerms(query.eventTypes);
  const nicknameTerms = normalizedTerms(query.nicknames);
  const explicitTerms = new Set([...topicTerms, ...eventTerms, ...nicknameTerms]);
  const similarity = Math.max(0, cosineSimilarity(candidate.embedding, query.queryEmbedding));

  return (similarity * 0.55)
    + (overlapScore(candidate.participantIds, participantTerms) * 0.15)
    + (overlapScore(candidate.topicTags, topicTerms) * 0.1)
    + (overlapScore(candidate.eventTypes, eventTerms) * 0.07)
    + (recencyScore(candidate.startedAt, now) * 0.08)
    + (overlapScore(candidate.nicknames, nicknameTerms) * 0.05)
    - sensitiveTopicPenalty(candidate, explicitTerms);
}

/**
 * Hybrid in-memory ranker. Candidate metadata is ranked first; the encrypted
 * summary and turns are only decrypted for the room-isolated final selection.
 */
export class VectorContextRepository implements ContextRepository {
  constructor(
    private readonly source: ContextChunkSource,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async findRelevant(query: ContextQuery): Promise<RetrievedChunk[]> {
    const candidates = await this.source.listRankableChunks(query.roomId);
    const requiredParticipants = normalizedTerms(query.requiredParticipantIds ?? []);
    const ranked: RankedCandidate[] = candidates
      .filter((candidate) => candidate.roomId === query.roomId)
      .filter((candidate) => {
        if (requiredParticipants.size === 0) return true;
        const candidateParticipants = normalizedTerms(candidate.participantIds);
        return [...requiredParticipants].every((participantId) => candidateParticipants.has(participantId));
      })
      .map((candidate) => ({ candidate, score: scoreCandidate(candidate, query, this.now()) }))
      .filter(({ score }) => score >= MIN_RELEVANCE_SCORE)
      .sort((left, right) => right.score - left.score || left.candidate.chunkId.localeCompare(right.candidate.chunkId))
      .slice(0, Math.min(query.limit, 5));

    return Promise.all(ranked.map(async ({ candidate, score }) => {
      const decrypted = await candidate.decrypt();
      return { chunkId: candidate.chunkId, score, ...decrypted };
    }));
  }
}
