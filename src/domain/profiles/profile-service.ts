import { and, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";

import { getDb } from "@/db/client";
import {
  profileFactRevisions,
  profileFacts,
  type ProfileFactSource,
} from "@/db/schema";
import { decryptJson, encryptJson } from "@/domain/crypto/encrypted-json";
import { mergeProfileFact } from "@/domain/memory/profile-corrections";
import type { ModelGateway } from "@/domain/models/gateway";
import { OpenAIModelGateway } from "@/domain/models/openai-gateway";

export const profileFactKinds = [
  "relationship", "personality_tendency", "speech_pattern", "conversation_role",
  "seriousness_cue", "preferred_interaction", "sensitive_topic", "interest",
  "nickname", "repeated_event", "conflict_response", "reconciliation_style",
] as const;

export type ProfileFactKind = typeof profileFactKinds[number];

export type ProfileFactView = {
  id: string;
  participantId: string;
  kind: ProfileFactKind;
  value: string;
  conditions: string[];
  exceptions: string[];
  confidence: number;
  source: ProfileFactSource;
  locked: boolean;
  evidenceTurnIds: string[];
};

export type ProfileEditCommand = {
  participantId: string;
  factId?: string;
  kind: ProfileFactView["kind"];
  value: string;
  conditions: string[];
  exceptions: string[];
  action: "edit" | "confirm";
};

export type CorrectionChatInput = {
  participantId: string;
  userExplanation: string;
};

export type CorrectionProposal = {
  proposalId: string;
  participantId: string;
  factKind: ProfileFactView["kind"];
  oldValue: string | null;
  newValue: string;
  conditions: string[];
  exceptions: string[];
};

export type AiProfileFact = {
  analysisKey: string;
  participantId: string;
  targetFactId: string | null;
  kind: ProfileFactKind;
  value: string;
  conditions: string[];
  exceptions: string[];
  confidence: number;
  evidenceTurnIds: string[];
};

export type StoredProfileFact = {
  id: string;
  participantId: string;
  kind: string;
  encryptedValue: string;
  encryptedConditions: string;
  encryptedExceptions: string;
  evidenceTurnIds: string;
  confidence: number;
  source: ProfileFactSource;
  locked: boolean;
};

export type StoredProfileRevision = {
  id: string;
  profileFactId: string;
  encryptedPreviousValue: string | null;
  encryptedNextValue: string;
  encryptedConditions: string;
  encryptedExceptions: string;
  source: ProfileFactSource;
};

type NewStoredProfileFact = Omit<StoredProfileFact, "id">;
type ProfileFactUpdate = Omit<StoredProfileFact, "id" | "participantId" | "kind">;
type NewStoredRevision = Omit<StoredProfileRevision, "id">;

export interface ProfileRepository {
  transaction<T>(work: (repository: ProfileRepository) => Promise<T>): Promise<T>;
  listFacts(participantId: string): Promise<StoredProfileFact[]>;
  findFact(factId: string): Promise<StoredProfileFact | undefined>;
  createFact(fact: NewStoredProfileFact): Promise<StoredProfileFact>;
  updateFact(factId: string, update: ProfileFactUpdate): Promise<StoredProfileFact>;
  createRevision(revision: NewStoredRevision): Promise<StoredProfileRevision>;
  findRevision(revisionId: string): Promise<StoredProfileRevision | undefined>;
  updateRevisionSource(revisionId: string, source: ProfileFactSource): Promise<void>;
  cleanupAiAnalysis(analysisKeys: string[], legacyEvidenceTurnIds?: string[]): Promise<void>;
}

type DrizzleExecutor = Pick<
  NodePgDatabase<typeof import("@/db/schema")>,
  "select" | "insert" | "update" | "delete"
>;

function createDrizzleOperations(database: DrizzleExecutor): Omit<ProfileRepository, "transaction"> {
  return {
    async listFacts(participantId) {
      return database.select({
        id: profileFacts.id,
        participantId: profileFacts.participantId,
        kind: profileFacts.kind,
        encryptedValue: profileFacts.encryptedValue,
        encryptedConditions: profileFacts.encryptedConditions,
        encryptedExceptions: profileFacts.encryptedExceptions,
        evidenceTurnIds: profileFacts.evidenceTurnIds,
        confidence: profileFacts.confidence,
        source: profileFacts.source,
        locked: profileFacts.locked,
      }).from(profileFacts).where(eq(profileFacts.participantId, participantId));
    },

    async findFact(factId) {
      const rows = await database.select({
        id: profileFacts.id,
        participantId: profileFacts.participantId,
        kind: profileFacts.kind,
        encryptedValue: profileFacts.encryptedValue,
        encryptedConditions: profileFacts.encryptedConditions,
        encryptedExceptions: profileFacts.encryptedExceptions,
        evidenceTurnIds: profileFacts.evidenceTurnIds,
        confidence: profileFacts.confidence,
        source: profileFacts.source,
        locked: profileFacts.locked,
      }).from(profileFacts).where(eq(profileFacts.id, factId));
      return rows[0];
    },

    async createFact(fact) {
      const rows = await database.insert(profileFacts).values(fact).returning();
      const created = rows[0];
      if (!created) throw new Error("Could not create profile fact");
      return created;
    },

    async updateFact(factId, update) {
      const rows = await database.update(profileFacts).set({
        ...update,
        updatedAt: new Date(),
      }).where(eq(profileFacts.id, factId)).returning();
      const updated = rows[0];
      if (!updated) throw new Error("Profile fact not found");
      return updated;
    },

    async createRevision(revision) {
      const rows = await database.insert(profileFactRevisions).values(revision).returning();
      const created = rows[0];
      if (!created) throw new Error("Could not create profile revision");
      return created;
    },

    async findRevision(revisionId) {
      const rows = await database.select({
        id: profileFactRevisions.id,
        profileFactId: profileFactRevisions.profileFactId,
        encryptedPreviousValue: profileFactRevisions.encryptedPreviousValue,
        encryptedNextValue: profileFactRevisions.encryptedNextValue,
        encryptedConditions: profileFactRevisions.encryptedConditions,
        encryptedExceptions: profileFactRevisions.encryptedExceptions,
        source: profileFactRevisions.source,
      }).from(profileFactRevisions).where(eq(profileFactRevisions.id, revisionId));
      return rows[0];
    },

    async updateRevisionSource(revisionId, source) {
      await database.update(profileFactRevisions).set({ source })
        .where(eq(profileFactRevisions.id, revisionId));
    },

    async cleanupAiAnalysis(analysisKeys, legacyEvidenceTurnIds = []) {
      if (analysisKeys.length === 0 && legacyEvidenceTurnIds.length === 0) return;
      const keys = new Set(analysisKeys);
      const legacyEvidence = new Set(legacyEvidenceTurnIds);
      const rows = await database.select({
        id: profileFactRevisions.id,
        profileFactId: profileFactRevisions.profileFactId,
        encryptedPreviousValue: profileFactRevisions.encryptedPreviousValue,
        encryptedNextValue: profileFactRevisions.encryptedNextValue,
        source: profileFactRevisions.source,
      }).from(profileFactRevisions).where(inArray(profileFactRevisions.source, [
        "ai_inference",
        "ai_change_proposal",
      ]));
      const owned = rows.filter((revision) => {
        const key = revisionValue(revision.encryptedNextValue).analysisKey;
        return key !== null && keys.has(key);
      });
      const legacyProposals = rows.filter((revision) => {
        if (revision.source !== "ai_change_proposal") return false;
        const value = revisionValue(revision.encryptedNextValue);
        return value.analysisKey === null
          && value.evidenceTurnIds.length > 0
          && value.evidenceTurnIds.every((turnId) => legacyEvidence.has(turnId));
      });

      for (const proposal of [...owned, ...legacyProposals].filter((revision, index, revisions) => (
        revision.source === "ai_change_proposal"
        && revisions.findIndex((candidate) => candidate.id === revision.id) === index
      ))) {
        await database.delete(profileFactRevisions).where(eq(profileFactRevisions.id, proposal.id));
      }

      // Restore updated facts by following the current analysis key backwards.
      // This preserves a fact that originated in an unrelated analysis.
      const inferenceRevisions = owned.filter((revision) => revision.source === "ai_inference");
      const remaining = new Set(inferenceRevisions.map((revision) => revision.id));
      let restored = true;
      while (restored) {
        restored = false;
        for (const revision of inferenceRevisions) {
          if (!remaining.has(revision.id)) continue;
          const factRows = await database.select({
            id: profileFacts.id,
            encryptedValue: profileFacts.encryptedValue,
            source: profileFacts.source,
            locked: profileFacts.locked,
          }).from(profileFacts).where(eq(profileFacts.id, revision.profileFactId));
          const current = factRows[0];
          const revisionKey = revisionValue(revision.encryptedNextValue).analysisKey;
          if (
            !current
            || current.locked
            || current.source !== "ai_inference"
            || factValue(current.encryptedValue).analysisKey !== revisionKey
          ) {
            continue;
          }
          const previous = revision.encryptedPreviousValue
            ? factSnapshot(revision.encryptedPreviousValue)
            : undefined;
          if (!previous) continue;
          await database.update(profileFacts).set({
            encryptedValue: encryptedFactValue(previous.value, previous.analysisKey),
            encryptedConditions: encryptJson(previous.conditions),
            encryptedExceptions: encryptJson(previous.exceptions),
            evidenceTurnIds: encryptJson(previous.evidenceTurnIds),
            confidence: previous.confidence,
            source: previous.source,
            locked: previous.locked,
            updatedAt: new Date(),
          }).where(eq(profileFacts.id, current.id));
          await database.delete(profileFactRevisions).where(eq(profileFactRevisions.id, revision.id));
          remaining.delete(revision.id);
          restored = true;
        }
      }
      if (remaining.size > 0) {
        await database.delete(profileFactRevisions)
          .where(inArray(profileFactRevisions.id, [...remaining]));
      }

      const factsToCheck = await database.select({
        id: profileFacts.id,
        encryptedValue: profileFacts.encryptedValue,
        evidenceTurnIds: profileFacts.evidenceTurnIds,
      }).from(profileFacts).where(and(
        eq(profileFacts.source, "ai_inference"),
        eq(profileFacts.locked, false),
      ));
      const factIds = factsToCheck.filter((fact) => {
        const key = factValue(fact.encryptedValue).analysisKey;
        if (key !== null) return keys.has(key);
        const evidence = decryptJson<string[]>(fact.evidenceTurnIds);
        return evidence.length > 0 && evidence.every((turnId) => legacyEvidence.has(turnId));
      }).map((fact) => fact.id);
      if (factIds.length > 0) {
        await database.delete(profileFacts).where(inArray(profileFacts.id, factIds));
      }
    },
  };
}

/** Production adapter; domain tests inject an in-memory implementation. */
export function createDrizzleProfileRepository(
  database: NodePgDatabase<typeof import("@/db/schema")> = getDb(),
): ProfileRepository {
  const operations = createDrizzleOperations(database);
  return {
    ...operations,
    transaction: (work) => database.transaction((transaction) => work({
      ...createDrizzleOperations(transaction as unknown as DrizzleExecutor),
      transaction: async (nestedWork) => nestedWork({
        ...createDrizzleOperations(transaction as unknown as DrizzleExecutor),
        transaction: async () => { throw new Error("Nested profile transactions are not supported"); },
      }),
    })),
  };
}

const correctionSchema = z.object({
  factKind: z.enum(profileFactKinds),
  existingFactId: z.string().nullable(),
  newValue: z.string().trim().min(1),
  conditions: z.array(z.string()),
  exceptions: z.array(z.string()),
});

function isProfileFactKind(value: string): value is ProfileFactKind {
  return (profileFactKinds as readonly string[]).includes(value);
}

function toView(fact: StoredProfileFact): ProfileFactView {
  if (!isProfileFactKind(fact.kind)) throw new Error(`Unknown profile fact kind: ${fact.kind}`);
  return {
    id: fact.id,
    participantId: fact.participantId,
    kind: fact.kind,
    value: factValue(fact.encryptedValue).value,
    conditions: decryptJson<string[]>(fact.encryptedConditions),
    exceptions: decryptJson<string[]>(fact.encryptedExceptions),
    confidence: fact.confidence,
    source: fact.source,
    locked: fact.locked,
    evidenceTurnIds: decryptJson<string[]>(fact.evidenceTurnIds),
  };
}

function encryptedFactContent(input: {
  value: string;
  conditions: string[];
  exceptions: string[];
  evidenceTurnIds: string[];
}, analysisKey: string | null = null) {
  return {
    encryptedValue: encryptedFactValue(input.value, analysisKey),
    encryptedConditions: encryptJson(input.conditions),
    encryptedExceptions: encryptJson(input.exceptions),
    evidenceTurnIds: encryptJson(input.evidenceTurnIds),
  };
}

type FactValue = { value: string; analysisKey: string | null };

type AiFactValuePayload = {
  version: 1;
  value: string;
  analysisKey: string;
};

function encryptedFactValue(value: string, analysisKey: string | null): string {
  return analysisKey
    ? encryptJson<AiFactValuePayload>({ version: 1, value, analysisKey })
    : encryptJson(value);
}

function factValue(payload: string): FactValue {
  const decoded = decryptJson<unknown>(payload);
  if (typeof decoded === "string") return { value: decoded, analysisKey: null };
  if (
    typeof decoded === "object"
    && decoded !== null
    && "version" in decoded
    && decoded.version === 1
    && "value" in decoded
    && typeof decoded.value === "string"
    && "analysisKey" in decoded
    && typeof decoded.analysisKey === "string"
  ) {
    return { value: decoded.value, analysisKey: decoded.analysisKey };
  }
  throw new Error("Invalid encrypted profile fact value");
}

type RevisionValuePayload = {
  version: 1;
  value: string;
  evidenceTurnIds: string[];
  analysisKey: string | null;
};

function encryptedRevisionValue(
  value: string,
  evidenceTurnIds: string[],
  analysisKey: string | null = null,
): string {
  return encryptJson<RevisionValuePayload>({ version: 1, value, evidenceTurnIds, analysisKey });
}

function revisionValue(payload: string): RevisionValuePayload {
  const decoded = decryptJson<unknown>(payload);
  // Supports revision rows created before evidence was included in this payload.
  if (typeof decoded === "string") {
    return { version: 1, value: decoded, evidenceTurnIds: [], analysisKey: null };
  }
  if (
    typeof decoded === "object"
    && decoded !== null
    && "value" in decoded
    && typeof decoded.value === "string"
    && "evidenceTurnIds" in decoded
    && Array.isArray(decoded.evidenceTurnIds)
    && decoded.evidenceTurnIds.every((id) => typeof id === "string")
  ) {
    return {
      version: 1,
      value: decoded.value,
      evidenceTurnIds: decoded.evidenceTurnIds,
      analysisKey: "analysisKey" in decoded && typeof decoded.analysisKey === "string"
        ? decoded.analysisKey
        : null,
    };
  }
  throw new Error("Invalid encrypted profile revision value");
}

type ProfileFactSnapshot = {
  version: 1;
  value: string;
  analysisKey: string | null;
  conditions: string[];
  exceptions: string[];
  evidenceTurnIds: string[];
  confidence: number;
  source: ProfileFactSource;
  locked: boolean;
};

function encryptedFactSnapshot(fact: StoredProfileFact): string {
  const value = factValue(fact.encryptedValue);
  return encryptJson<ProfileFactSnapshot>({
    version: 1,
    value: value.value,
    analysisKey: value.analysisKey,
    conditions: decryptJson<string[]>(fact.encryptedConditions),
    exceptions: decryptJson<string[]>(fact.encryptedExceptions),
    evidenceTurnIds: decryptJson<string[]>(fact.evidenceTurnIds),
    confidence: fact.confidence,
    source: fact.source,
    locked: fact.locked,
  });
}

function factSnapshot(payload: string): ProfileFactSnapshot | undefined {
  const decoded = decryptJson<unknown>(payload);
  if (
    typeof decoded !== "object"
    || decoded === null
    || !("version" in decoded)
    || decoded.version !== 1
    || !("value" in decoded)
    || typeof decoded.value !== "string"
    || !("analysisKey" in decoded)
    || !(typeof decoded.analysisKey === "string" || decoded.analysisKey === null)
    || !("conditions" in decoded)
    || !Array.isArray(decoded.conditions)
    || !decoded.conditions.every((value) => typeof value === "string")
    || !("exceptions" in decoded)
    || !Array.isArray(decoded.exceptions)
    || !decoded.exceptions.every((value) => typeof value === "string")
    || !("evidenceTurnIds" in decoded)
    || !Array.isArray(decoded.evidenceTurnIds)
    || !decoded.evidenceTurnIds.every((value) => typeof value === "string")
    || !("confidence" in decoded)
    || typeof decoded.confidence !== "number"
    || !("source" in decoded)
    || !["ai_inference", "user_confirmed", "user_edited", "ai_change_proposal"].includes(String(decoded.source))
    || !("locked" in decoded)
    || typeof decoded.locked !== "boolean"
  ) {
    return undefined;
  }
  return decoded as ProfileFactSnapshot;
}

function assertAiFact(input: AiProfileFact): void {
  if (!input.analysisKey) throw new Error("AI profile facts require an analysis key");
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new RangeError("AI profile confidence must be between 0 and 1");
  }
  if (input.evidenceTurnIds.length === 0) {
    throw new Error("AI profile facts require evidence turn IDs");
  }
}

function sameStrings(left: string[], right: string[]): boolean {
  const normalizedLeft = left.map((value) => value.trim()).sort();
  const normalizedRight = right.map((value) => value.trim()).sort();
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

export class ProfileService {
  constructor(
    private readonly repository: ProfileRepository,
    private readonly gateway?: ModelGateway,
  ) {}

  async listProfileFacts(
    participantId: string,
    excludedAnalysisKeys: string[] = [],
  ): Promise<ProfileFactView[]> {
    const excluded = new Set(excludedAnalysisKeys);
    const facts = await this.repository.listFacts(participantId);
    return facts.filter((fact) => (
      fact.source !== "ai_change_proposal"
      && !excluded.has(factValue(fact.encryptedValue).analysisKey ?? "")
    )).map(toView);
  }

  async applyProfileEdit(command: ProfileEditCommand): Promise<ProfileFactView> {
    const source: ProfileFactSource = command.action === "edit" ? "user_edited" : "user_confirmed";
    return this.repository.transaction(async (repository) => {
      if (!command.factId) {
        const content = encryptedFactContent({ ...command, evidenceTurnIds: [] });
        return toView(await repository.createFact({
          participantId: command.participantId,
          kind: command.kind,
          ...content,
          confidence: 1,
          source,
          locked: true,
        }));
      }

      const existing = await repository.findFact(command.factId);
      if (!existing || existing.participantId !== command.participantId) {
        throw new Error("Profile fact not found");
      }
      if (existing.kind !== command.kind) throw new Error("Profile fact kind cannot be changed");
      const content = encryptedFactContent({
        ...command,
        evidenceTurnIds: command.action === "confirm"
          ? decryptJson<string[]>(existing.evidenceTurnIds)
          : [],
      });
      await repository.createRevision({
        profileFactId: existing.id,
        encryptedPreviousValue: existing.encryptedValue,
        encryptedNextValue: encryptedRevisionValue(command.value, []),
        encryptedConditions: content.encryptedConditions,
        encryptedExceptions: content.encryptedExceptions,
        source,
      });
      return toView(await repository.updateFact(existing.id, {
        ...content,
        confidence: 1,
        source,
        locked: true,
      }));
    });
  }

  async applyAiInference(input: AiProfileFact): Promise<ProfileFactView> {
    assertAiFact(input);
    return this.repository.transaction((repository) => this.applyAiInferenceWithRepository(input, repository));
  }

  async replaceAiAnalysis(
    analysisKeys: string[],
    facts: AiProfileFact[],
    legacyEvidenceTurnIds: string[] = [],
  ): Promise<ProfileFactView[]> {
    if (analysisKeys.some((key) => !key)) {
      throw new Error("AI profile replacement requires non-empty analysis keys");
    }
    const allowedKeys = new Set(analysisKeys);
    for (const fact of facts) {
      assertAiFact(fact);
      if (!allowedKeys.has(fact.analysisKey)) {
        throw new Error("AI profile fact analysis key is outside the replacement set");
      }
    }
    return this.repository.transaction(async (repository) => {
      await repository.cleanupAiAnalysis(analysisKeys, legacyEvidenceTurnIds);
      const views: ProfileFactView[] = [];
      for (const fact of facts) {
        views.push(await this.applyAiInferenceWithRepository(fact, repository));
      }
      return views;
    });
  }

  private async applyAiInferenceWithRepository(
    input: AiProfileFact,
    repository: ProfileRepository,
  ): Promise<ProfileFactView> {
    const existingFacts = (await repository.listFacts(input.participantId))
      .filter((fact) => fact.kind === input.kind && fact.source !== "ai_change_proposal");
    const exact = existingFacts.find((fact) => {
      const view = toView(fact);
      return view.value === input.value
        && sameStrings(view.conditions, input.conditions)
        && sameStrings(view.exceptions, input.exceptions);
    });
    let existing: StoredProfileFact | undefined;
    if (input.targetFactId) {
      const target = await repository.findFact(input.targetFactId);
      if (
        !target
        || target.participantId !== input.participantId
        || target.kind !== input.kind
        || target.source === "ai_change_proposal"
      ) {
        throw new Error("AI profile target must match the same participant and fact kind");
      }
      existing = target;
    } else {
      existing = exact;
    }
    const incoming = {
      value: input.value,
      conditions: input.conditions,
      exceptions: input.exceptions,
      confidence: input.confidence,
      source: "ai_inference" as const,
      locked: false,
    };
    const content = encryptedFactContent(input, input.analysisKey);

    if (!existing) {
      return toView(await repository.createFact({
        participantId: input.participantId,
        kind: input.kind,
        ...content,
        confidence: input.confidence,
        source: "ai_inference",
        locked: false,
      }));
    }

    const current = toView(existing);
    const matchesExisting = current.value === input.value
      && sameStrings(current.conditions, input.conditions)
      && sameStrings(current.exceptions, input.exceptions);
    if (matchesExisting && (
      current.locked
      || current.source === "user_edited"
      || current.source === "user_confirmed"
    )) {
      return current;
    }
    const merged = mergeProfileFact(current, incoming);
    if (merged.proposal) {
      const revision = await repository.createRevision({
        profileFactId: existing.id,
        encryptedPreviousValue: existing.encryptedValue,
        encryptedNextValue: encryptedRevisionValue(
          input.value,
          input.evidenceTurnIds,
          input.analysisKey,
        ),
        encryptedConditions: content.encryptedConditions,
        encryptedExceptions: content.encryptedExceptions,
        source: "ai_change_proposal",
      });
      return {
        id: revision.id,
        participantId: input.participantId,
        kind: input.kind,
        value: input.value,
        conditions: input.conditions,
        exceptions: input.exceptions,
        confidence: input.confidence,
        source: "ai_change_proposal",
        locked: false,
        evidenceTurnIds: input.evidenceTurnIds,
      };
    }

    await repository.createRevision({
      profileFactId: existing.id,
      encryptedPreviousValue: encryptedFactSnapshot(existing),
      encryptedNextValue: encryptedRevisionValue(
        input.value,
        input.evidenceTurnIds,
        input.analysisKey,
      ),
      encryptedConditions: content.encryptedConditions,
      encryptedExceptions: content.encryptedExceptions,
      source: "ai_inference",
    });
    return toView(await repository.updateFact(existing.id, {
      ...content,
      confidence: input.confidence,
      source: "ai_inference",
      locked: false,
    }));
  }

  async proposeProfileCorrection(input: CorrectionChatInput): Promise<CorrectionProposal> {
    if (!this.gateway) throw new Error("A model gateway is required for correction chat");
    const currentFacts = await this.listProfileFacts(input.participantId);
    const result = await this.gateway.extract({
      purpose: "analysis",
      schemaName: "profile_correction",
      schema: correctionSchema,
      system: [
        "Map the user's correction to exactly one profile fact.",
        "Return conditions and exceptions explicitly instead of making unconditional personality claims.",
        "Use an existingFactId only when the supplied fact is the one being corrected.",
      ].join(" "),
      input: JSON.stringify({
        participantId: input.participantId,
        userExplanation: input.userExplanation,
        currentFacts,
      }),
    });

    return this.repository.transaction(async (repository) => {
      const requested = result.existingFactId
        ? await repository.findFact(result.existingFactId)
        : undefined;
      const matching = requested?.participantId === input.participantId && requested.kind === result.factKind
        ? requested
        : (await repository.listFacts(input.participantId))
          .find((fact) => fact.kind === result.factKind && fact.source !== "ai_change_proposal");
      const encryptedNextValue = encryptedRevisionValue(result.newValue, []);
      const encryptedConditions = encryptJson(result.conditions);
      const encryptedExceptions = encryptJson(result.exceptions);

      if (matching) {
        const revision = await repository.createRevision({
          profileFactId: matching.id,
          encryptedPreviousValue: matching.encryptedValue,
          encryptedNextValue,
          encryptedConditions,
          encryptedExceptions,
          source: "ai_change_proposal",
        });
        return {
          proposalId: revision.id,
          participantId: input.participantId,
          factKind: result.factKind,
          oldValue: factValue(matching.encryptedValue).value,
          newValue: result.newValue,
          conditions: result.conditions,
          exceptions: result.exceptions,
        };
      }

      const proposal = await repository.createFact({
        participantId: input.participantId,
        kind: result.factKind,
        encryptedValue: encryptJson(result.newValue),
        encryptedConditions,
        encryptedExceptions,
        evidenceTurnIds: encryptJson([]),
        confidence: 1,
        source: "ai_change_proposal",
        locked: false,
      });
      return {
        proposalId: proposal.id,
        participantId: input.participantId,
        factKind: result.factKind,
        oldValue: null,
        newValue: result.newValue,
        conditions: result.conditions,
        exceptions: result.exceptions,
      };
    });
  }

  async confirmProfileCorrection(participantId: string, proposalId: string): Promise<ProfileFactView> {
    return this.repository.transaction(async (repository) => {
      const revision = await repository.findRevision(proposalId);
      if (revision?.source === "ai_change_proposal") {
        const existing = await repository.findFact(revision.profileFactId);
        if (!existing || existing.participantId !== participantId) throw new Error("Correction proposal not found");
        const next = revisionValue(revision.encryptedNextValue);
        const updated = await repository.updateFact(existing.id, {
          encryptedValue: encryptJson(next.value),
          encryptedConditions: revision.encryptedConditions,
          encryptedExceptions: revision.encryptedExceptions,
          evidenceTurnIds: encryptJson(next.evidenceTurnIds),
          confidence: 1,
          source: "user_confirmed",
          locked: true,
        });
        await repository.updateRevisionSource(revision.id, "user_confirmed");
        return toView(updated);
      }

      const newFactProposal = await repository.findFact(proposalId);
      if (
        !newFactProposal
        || newFactProposal.participantId !== participantId
        || newFactProposal.source !== "ai_change_proposal"
      ) {
        throw new Error("Correction proposal not found");
      }
      return toView(await repository.updateFact(newFactProposal.id, {
        encryptedValue: newFactProposal.encryptedValue,
        encryptedConditions: newFactProposal.encryptedConditions,
        encryptedExceptions: newFactProposal.encryptedExceptions,
        evidenceTurnIds: encryptJson([]),
        confidence: 1,
        source: "user_confirmed",
        locked: true,
      }));
    });
  }
}

export async function listProfileFacts(
  participantId: string,
  repository: ProfileRepository = createDrizzleProfileRepository(),
): Promise<ProfileFactView[]> {
  return new ProfileService(repository).listProfileFacts(participantId);
}

export async function applyProfileEdit(
  command: ProfileEditCommand,
  repository: ProfileRepository = createDrizzleProfileRepository(),
): Promise<ProfileFactView> {
  return new ProfileService(repository).applyProfileEdit(command);
}

export async function proposeProfileCorrection(
  input: CorrectionChatInput,
  repository: ProfileRepository = createDrizzleProfileRepository(),
  gateway: ModelGateway = new OpenAIModelGateway(),
): Promise<CorrectionProposal> {
  return new ProfileService(repository, gateway).proposeProfileCorrection(input);
}

export async function confirmProfileCorrection(
  participantId: string,
  proposalId: string,
  repository: ProfileRepository = createDrizzleProfileRepository(),
): Promise<ProfileFactView> {
  return new ProfileService(repository).confirmProfileCorrection(participantId, proposalId);
}
