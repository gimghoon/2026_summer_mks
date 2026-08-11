import { z } from "zod";

import type { ProfileFactSource, RelationshipStyle, ReplyStrategy } from "@/db/schema";
import {
  ModelResponseValidationError,
  type ModelGateway,
} from "@/domain/models/gateway";
import type { CurrentContextSelection } from "@/domain/replies/context-expander";
import {
  buildPersonalContextEvidence,
  resolveContextBasis,
} from "@/domain/replies/reply-evidence";
import {
  invalidRequiredBasisIds,
  PERSONAL_CONTEXT_UNAVAILABLE_MESSAGE,
  selectRequiredPersonalContext,
} from "@/domain/replies/required-personal-context";
import {
  type PersonalContextUsageValidator,
} from "@/domain/replies/personal-context-usage-validator";
import { protectedIntentKind } from "@/domain/replies/protected-intent";
import {
  buildStylePolicy,
  supportedPersonalStyleDevices,
  type IndirectnessLevel,
  type StylePolicy,
} from "@/domain/replies/style-policy";
import type { RetrievedChunk } from "@/domain/retrieval/context-repository";

const strategyOrder = [
  "relationship_soft",
  "emotion_signal",
  "clearer_request",
] as const satisfies readonly ReplyStrategy[];

export type ReplyWarning =
  | "emotional_inference"
  | "duplicate_text"
  | "relationship_boundary"
  | "agency_or_safety"
  | "personal_style_mismatch"
  | "specific_fact_inference"
  | "profile_conflict"
  | "important_intent_ambiguity"
  | "unverified_profile_context";

export type ReplyCandidateContent = {
  strategy: ReplyStrategy;
  text: string;
  intentLabel: string;
  riskLabel: string | null;
};

export type ReplyCandidate = ReplyCandidateContent & {
  contextBasis: string[];
  warnings: ReplyWarning[];
};

export type ReplyGenerationResult =
  | { kind: "clarification_required"; question: string }
  | { kind: "personal_context_unavailable"; message: string }
  | { kind: "replies"; candidates: [ReplyCandidate, ReplyCandidate, ReplyCandidate] };

export type GenerateRepliesCommand = {
  roomId: string;
  participantId: string;
  pastedConversation: string;
  situation: string;
  intent: string;
  indirectness: IndirectnessLevel;
  personalContextMode: PersonalContextMode;
};

export type PersonalContextMode = "normal" | "required";

export type ParticipantProfileContext = {
  id: string;
  kind: string;
  value: string;
  conditions?: string[];
  exceptions?: string[];
  source: ProfileFactSource;
  locked: boolean;
};

export type ReplyGenerationContext = {
  relationship: RelationshipStyle;
  currentContext: CurrentContextSelection;
  retrievedChunks: RetrievedChunk[];
  roomMemory: string | null;
  participantProfiles: ParticipantProfileContext[];
  /** Optional reviewed non-profile facts that a production adapter can validate more strictly. */
  currentFacts?: string[];
};

export interface ReplyContextProvider {
  loadParticipantProfiles(
    command: GenerateRepliesCommand,
  ): Promise<ParticipantProfileContext[]>;
  load(
    command: GenerateRepliesCommand,
    preloadedProfiles?: ParticipantProfileContext[],
  ): Promise<ReplyGenerationContext>;
}

export type ReplyFactValidator = (
  candidate: ReplyCandidateContent,
  context: ReplyGenerationContext,
) => boolean | Promise<boolean>;

export type ReplyServiceDependencies = {
  gateway: ModelGateway;
  contextProvider: ReplyContextProvider;
  factValidator: ReplyFactValidator;
  personalContextUsageValidator: PersonalContextUsageValidator;
};

export type ReplyValidationRuleId =
  | "OUTPUT_STRUCTURE"
  | "DUPLICATE_TEXT"
  | "RELATIONSHIP_FORBIDDEN_CUE"
  | "AGENCY_OR_SAFETY_VIOLATION"
  | "UNSUPPORTED_PERSONAL_DEVICE"
  | "UNSUPPORTED_SPECIFIC_FACT"
  | "FACT_CONTRADICTION"
  | "EXPLICIT_INTENT_AMBIGUOUS"
  | "REQUIRED_PERSONAL_CONTEXT_MISSING"
  | "PERSONAL_CONTEXT_NOT_REFLECTED";

export type ReplyAdvisoryValidationRuleId = Exclude<
  ReplyValidationRuleId,
  | "OUTPUT_STRUCTURE"
  | "REQUIRED_PERSONAL_CONTEXT_MISSING"
  | "PERSONAL_CONTEXT_NOT_REFLECTED"
>;

export type CandidateValidationResult = { ruleIds: ReplyAdvisoryValidationRuleId[] };

const warningByRule = {
  DUPLICATE_TEXT: "duplicate_text",
  RELATIONSHIP_FORBIDDEN_CUE: "relationship_boundary",
  AGENCY_OR_SAFETY_VIOLATION: "agency_or_safety",
  UNSUPPORTED_PERSONAL_DEVICE: "personal_style_mismatch",
  UNSUPPORTED_SPECIFIC_FACT: "specific_fact_inference",
  FACT_CONTRADICTION: "profile_conflict",
  EXPLICIT_INTENT_AMBIGUOUS: "important_intent_ambiguity",
} as const satisfies Record<ReplyAdvisoryValidationRuleId, ReplyWarning>;

const contentRuleOrder = Object.keys(warningByRule) as ReplyAdvisoryValidationRuleId[];

export function warningForRule(ruleId: ReplyAdvisoryValidationRuleId): ReplyWarning {
  return warningByRule[ruleId];
}

function flattenValidationRuleIds(results: CandidateValidationResult[]): ReplyAdvisoryValidationRuleId[] {
  const found = new Set(results.flatMap((result) => result.ruleIds));
  return contentRuleOrder.filter((ruleId) => found.has(ruleId));
}

export class ReplyGenerationValidationError extends Error {
  readonly ruleIds: ReplyValidationRuleId[];

  constructor(ruleIds: ReplyValidationRuleId[]) {
    super(`Reply generation failed validation: ${ruleIds.join(",")}`);
    this.name = "ReplyGenerationValidationError";
    this.ruleIds = ruleIds;
  }
}

const candidateFields = {
  text: z.string().trim().min(1).max(500),
  intentLabel: z.string().trim().min(1).max(120),
  riskLabel: z.string().trim().min(1).max(160).nullable(),
};

const generatedCandidateSchema = z.object({
  strategy: z.enum(strategyOrder),
  ...candidateFields,
  contextBasisIds: z.array(z.string().trim().min(1).max(80)).max(2),
});

const generatedReplySchema = z.object({
  candidates: z.array(generatedCandidateSchema).length(3),
});

type GeneratedReply = z.infer<typeof generatedReplySchema>;

function hasExpectedStrategyOrder(candidates: GeneratedReply["candidates"]): boolean {
  return candidates.every((candidate, index) => candidate.strategy === strategyOrder[index]);
}

const forbiddenCuePatterns: Record<string, RegExp[]> = {
  romantic_affection: [
    /사랑해|사랑한다|좋아해|좋아하는\s*마음|자기야|여보|내\s*사랑|우리\s*애기/iu,
    /너밖에\s*없|보고\s*싶|설레|두근(?:거려|대)/iu,
  ],
  jealousy: [
    /질투|다른\s*(?:여자|남자|사람).*만나|나보다\s*걔가\s*더\s*좋/iu,
    /누구랑\s*있었(?:어|니).*왜/iu,
  ],
  exclusive_possession: [
    /너는\s*내\s*거|나만\s*(?:봐|만나|생각)|다른\s*사람은\s*보지\s*마/iu,
  ],
  coercion: [
    /안\s*하면.{0,12}(?:헤어|후회|가만)|해야만\s*(?:해|돼)|무조건\s*(?:해|와|보내)/iu,
  ],
  harassment: [
    /답할\s*때까지|계속\s*연락할|집으로\s*찾아갈|어디든\s*따라갈/iu,
  ],
  threat: [
    /가만(?:히)?\s*안\s*(?:둘|놔)|죽여|망하게|다\s*퍼뜨릴|후회하게\s*해/iu,
  ],
  shaming: [
    /왜\s*그것도\s*못|정상적인\s*사람이면|양심(?:이|도)?\s*있|사람이라면\s*당연/iu,
  ],
  guilt_tripping: [
    /날\s*사랑한다면|나를\s*생각한다면|너\s*때문에\s*내가|내가\s*얼마나\s*힘든데/iu,
  ],
  conflict_escalation: [
    /싸우자|끝장을\s*보|주변에\s*다\s*말할|똑같이\s*갚아/iu,
  ],
};

const safetyCueIds = new Set([
  "coercion",
  "harassment",
  "threat",
  "shaming",
  "guilt_tripping",
  "conflict_escalation",
]);

function normalizeForDistinctness(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
}

function contextTexts(command: GenerateRepliesCommand, context: ReplyGenerationContext): string[] {
  return [
    command.situation,
    command.intent,
    context.roomMemory ?? "",
    ...(context.currentFacts ?? []),
    ...context.participantProfiles.flatMap((profile) => [
      profile.value,
      ...(profile.conditions ?? []),
      ...(profile.exceptions ?? []),
    ]),
    ...context.currentContext.turns.flatMap((turn) => turn.messages.map((message) => message.text)),
    ...context.retrievedChunks.flatMap((chunk) => [
      chunk.summary,
      ...chunk.turns.flatMap((turn) => turn.messages.map((message) => message.text)),
    ]),
  ].filter(Boolean);
}

function unsupportedSpecificFact(text: string, knownTexts: string[]): boolean {
  const normalizedKnown = knownTexts.join("\n").normalize("NFKC").toLocaleLowerCase();
  const markers = text.normalize("NFKC").toLocaleLowerCase().match(
    /(?:https?:\/\/\S+|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\d{1,4}(?::\d{2}|[./-]\d{1,2})+(?:[./-]\d{1,4})?|\d+(?:만|천|백)?\s*(?:원|명|번|시|분|일|주|개월|년))/giu,
  ) ?? [];
  return markers.some((marker) => !normalizedKnown.includes(marker));
}

function usesUnsupportedPersonalDevice(text: string, policy: StylePolicy): boolean {
  const normalized = text.normalize("NFKC");
  const usedDevices = new Set<string>();
  if (/(?:ㅋㅋ|ㅎㅎ|ᄏᄏ|ᄒᄒ)/u.test(normalized)) usedDevices.add("laughter");
  if (/[아야어여오요우유으이]{3,}/u.test(normalized)) usedDevices.add("vowel_repetition");
  if (/[~～]/u.test(normalized)) usedDevices.add("tilde");
  if (/\p{Extended_Pictographic}/u.test(normalized)) usedDevices.add("emoji");
  return [...usedDevices].some((device) => !policy.allowedDevices.includes(device));
}

function includesForbiddenCue(text: string, policy: StylePolicy): {
  relationship: boolean;
  safety: boolean;
} {
  let relationship = false;
  let safety = false;
  for (const cue of policy.forbiddenCues) {
    const matches = forbiddenCuePatterns[cue]?.some((pattern) => pattern.test(text)) ?? false;
    if (!matches) continue;
    if (safetyCueIds.has(cue)) safety = true;
    else if (cue !== "invented_fact") relationship = true;
  }
  return { relationship, safety };
}

function isMoneyAllocationIntent(intent: string): boolean {
  return /같이|공동|모임|활동/u.test(intent)
    && /개인|각자|알아서|쇼핑/u.test(intent)
    && /돈|비용|회비|정산|걷/u.test(intent);
}

function preservesMoneyAllocation(text: string): boolean {
  const shared = /(?:같이|공동|모임|활동|공금).{0,20}(?:한\s*번에|모아|걷|정산|같이\s*내)|(?:한\s*번에|모아|걷|정산).{0,20}(?:같이|공동|모임|활동|공금)/u.test(text);
  const personal = /(?:개인|각자|쇼핑).{0,20}(?:각자|알아서|따로|본인|부담|쓰|내)|(?:각자|알아서|따로|본인).{0,20}(?:개인|쇼핑|비용|돈)/u.test(text);
  return shared && personal;
}

function preservesExplicitIntent(intent: string, text: string): boolean {
  const normalizedIntent = intent.normalize("NFKC").toLocaleLowerCase();
  switch (protectedIntentKind(intent)) {
    case "money": {
      if (isMoneyAllocationIntent(normalizedIntent)) {
        return preservesMoneyAllocation(text);
      }
      const refusal = /(?:돈|금전|금액|송금|입금|빌려|결제|환불).{0,18}(?:안\s*(?:돼|할|보낼|빌려)|못\s*(?:해|보내|빌려)|거절|어려워서.{0,8}안)|(?:안|못).{0,12}(?:송금|입금|빌려|결제)/u.test(text);
      const acceptance = /(?:송금할게|입금할게|빌려줄게|결제할게|갚을게|상환할게)|(?:돈|금전|금액|송금|입금|빌려|결제|환불).{0,18}(?:보낼게|송금할게|입금할게|빌려줄게|결제할게|갚을게|상환할게|받을게|수락(?:할게|해)|동의해)|(?:보낼게|송금할게|입금할게|빌려줄게|결제할게|갚을게|상환할게|받을게|수락(?:할게|해)).{0,12}(?:돈|금전|금액|송금|입금|환불)/u.test(text);
      const request = /(?:송금해|입금해|결제해|갚아)\s*줘(?!서)|(?:돈|금전|금액|송금|입금|비용|회비|대출|빚|빌려|계좌|결제|환불|상환|갚).{0,18}(?:보내\s*줘(?!서)|해\s*줄래\?|할\s*수\s*있어\?|부탁해)|(?:보내\s*줘(?!서)|해\s*줄래\?|할\s*수\s*있어\?|부탁해).{0,12}(?:돈|금전|금액|송금|입금|비용|회비|대출|빚|빌려|계좌|결제|환불|상환|갚)/u.test(text);
      if (/refusal|reject|decline|deny|거절|거부/u.test(normalizedIntent)) return refusal;
      if (/request|ask|요청|부탁/u.test(normalizedIntent)) return request;
      if (/accept|approve|agree|payment|pay|repay|send|수락|승인|지불|송금/u.test(normalizedIntent)) {
        return acceptance;
      }
      return refusal || acceptance || request;
    }
    case "consent":
      if (/boundary|refusal|reject|decline|거절|거부|경계/u.test(normalizedIntent)) {
        return /동의하지\s*않|원하지\s*않|싫어|하지\s*마|멈춰|안\s*(?:돼|할래)/u.test(text);
      }
      return /(?:동의|스킨십|키스|만져|이렇게\s*해).{0,12}(?:괜찮(?:아|은지)\?|원해\?|동의해\?)/u.test(text);
    case "safety":
      return /신고(?:할게|하자)|(?:112|119)(?:에|로)?\s*(?:신고|전화|연락)|(?:신고|전화|연락).{0,6}(?:112|119)|도움\s*(?:요청|청할)|연락할게|혼자\s*안\s*갈|가지\s*않을|안전한?.{0,10}(?:방법|곳|길|택시)|택시\s*(?:탈게|타자)/u.test(text);
    case "refusal":
      return /거절|싫어|하지\s*않을|안\s*(?:돼|할래|할게)|못\s*(?:해|할)|어려워서.{0,8}안/u.test(text);
    case "promise":
      if (/change|cancel|resched|변경|취소|미루|바꾸/u.test(normalizedIntent)) {
        const statesChange = /(?:약속|계약|예약|마감).{0,18}(?:변경|취소|미루|바꾸|바꿔|못\s*지킬)|(?:변경|취소|미루|바꾸|바꿔|못\s*지킬).{0,12}(?:약속|계약|예약|마감)/u.test(text);
        const negatesChange = /(?:변경|취소|미루|바꾸|바꿔).{0,12}(?:하지\s*않|지\s*않|안\s*할|못\s*할|할\s*수\s*없|않을|어렵|불가능|말자)|(?:안|않|못).{0,8}(?:변경|취소|미루|바꾸|바꿔)/u.test(text);
        return statesChange && !negatesChange;
      }
      return /(?:약속|계약|예약|마감).{0,18}(?:지킬|못|할게|않|취소|유지)|(?:지킬|못\s*지킬).{0,12}약속/u.test(text);
    default:
      return true;
  }
}

function modelContext(
  context: ReplyGenerationContext,
  participantProfiles: ParticipantProfileContext[],
  currentFacts: string[] = context.currentFacts ?? [],
) {
  return {
    currentTurns: context.currentContext.turns.map((turn) => ({
      speakerId: turn.speakerId,
      startedAt: turn.startedAt,
      messages: turn.messages.map((message) => ({ kind: message.kind, text: message.text })),
    })),
    retrievedHistory: context.retrievedChunks.map((chunk) => ({
      summary: chunk.summary,
      turns: chunk.turns.map((turn) => ({
        speakerId: turn.speakerId,
        startedAt: turn.startedAt,
        messages: turn.messages.map((message) => ({ kind: message.kind, text: message.text })),
      })),
    })),
    roomMemory: context.roomMemory,
    participantProfiles,
    currentFacts,
  };
}

function creativeIndirectnessGuidance(level: IndirectnessLevel): string {
  if (level === 6) {
    return "At level 6, avoid directly naming the emotion or request when the intent is not protected; imply it through the supplied situation, a hedged question, a pause, or a lingering ending.";
  }
  if (level === 7) {
    return "At level 7, stay natural and concise. Use only material from the supplied conversation. Give candidate one a contextual metaphor, candidate two a playful implication or paradox, and candidate three a quiet aftertaste. Never add unrelated poetry or invented facts.";
  }
  return "";
}

function generationSystem(policy: StylePolicy, requiresPersonalContext: boolean): string {
  return [
    "Generate exactly three concise Korean KakaoTalk reply candidates.",
    "The user explicitly selected a Korean-women-in-their-20s '여자어' concept: treat it as an opt-in writing style, never as a fact about all women.",
    `Keep this exact strategy order: ${strategyOrder.join(", ")}.`,
    "Give the three candidates genuinely different strategies while keeping the same requested indirectness level.",
    "Use only supplied facts. Do not invent events, people, dates, promises, feelings, or relationship history.",
    "Preserve the user's agency: never coerce, threaten, harass, shame, manipulate, or intensify conflict.",
    "Do not include romantic, jealousy, or possessive cues when the relationship is female_friend.",
    "For money, consent, safety, firm rejection, and important promises, keep the actual decision unambiguous at every indirectness level.",
    creativeIndirectnessGuidance(policy.indirectness),
    "Personal device mapping: laughter=ㅋㅋ/ㅎㅎ, vowel_repetition=repeated Korean vowels, tilde=~, emoji=emoji. Use a personal device only if its key is listed in Policy.allowedDevices.",
    `Policy: ${JSON.stringify(policy)}`,
    requiresPersonalContext
      ? "For every candidate, choose at least one supplied personalContextEvidence ID and naturally apply that fact; put the chosen IDs in contextBasisIds."
      : "",
    "On a retry, validationRuleIds are opaque rule identifiers. Correct those rules without quoting or discussing the previous text.",
  ].join(" ");
}

async function validateCandidates(
  candidates: [ReplyCandidateContent, ReplyCandidateContent, ReplyCandidateContent],
  command: GenerateRepliesCommand,
  context: ReplyGenerationContext,
  policy: StylePolicy,
  factValidator: ReplyFactValidator,
): Promise<CandidateValidationResult[]> {
  const normalized = candidates.map((candidate) => normalizeForDistinctness(candidate.text));
  const normalizedCounts = new Map<string, number>();
  for (const text of normalized) normalizedCounts.set(text, (normalizedCounts.get(text) ?? 0) + 1);

  const knownTexts = contextTexts(command, context);
  const results: CandidateValidationResult[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const errors = new Set<ReplyAdvisoryValidationRuleId>();
    if ((normalizedCounts.get(normalized[index]!) ?? 0) > 1) errors.add("DUPLICATE_TEXT");
    const forbidden = includesForbiddenCue(candidate.text, policy);
    if (forbidden.relationship) errors.add("RELATIONSHIP_FORBIDDEN_CUE");
    if (forbidden.safety) errors.add("AGENCY_OR_SAFETY_VIOLATION");
    if (usesUnsupportedPersonalDevice(candidate.text, policy)) errors.add("UNSUPPORTED_PERSONAL_DEVICE");
    if (unsupportedSpecificFact(candidate.text, knownTexts)) errors.add("UNSUPPORTED_SPECIFIC_FACT");
    if (!(await factValidator(candidate, context))) errors.add("FACT_CONTRADICTION");
    if (policy.mustRemainExplicit && !preservesExplicitIntent(command.intent, candidate.text)) {
      errors.add("EXPLICIT_INTENT_AMBIGUOUS");
    }
    results.push({ ruleIds: [...errors] });
  }
  return results;
}

function withPublicCandidateMetadata(
  candidate: GeneratedReply["candidates"][number],
  personalContextEvidence: ReturnType<typeof buildPersonalContextEvidence>,
  warnings: ReplyWarning[] = [],
): ReplyCandidate {
  const { contextBasisIds, ...content } = candidate;
  return {
    ...content,
    contextBasis: resolveContextBasis(contextBasisIds, personalContextEvidence),
    warnings,
  };
}

function semanticUsageCandidates(
  candidates: [
    GeneratedReply["candidates"][number],
    GeneratedReply["candidates"][number],
    GeneratedReply["candidates"][number],
  ],
  allowedProfiles: ParticipantProfileContext[],
) {
  const profilesById = new Map(allowedProfiles.map((profile) => [profile.id, profile]));
  return candidates.map((candidate) => ({
    strategy: candidate.strategy,
    text: candidate.text,
    selectedFacts: candidate.contextBasisIds.flatMap((id) => {
      const profile = profilesById.get(id);
      return profile ? [{
        id: profile.id,
        kind: profile.kind,
        value: profile.value,
        conditions: profile.conditions ?? [],
        exceptions: profile.exceptions ?? [],
      }] : [];
    }),
  })) as Parameters<PersonalContextUsageValidator>[0];
}

function semanticUsageGrounding(
  command: GenerateRepliesCommand,
  context: ReplyGenerationContext,
): Parameters<PersonalContextUsageValidator>[1] {
  return {
    situation: command.situation,
    intent: command.intent,
    currentTurns: context.currentContext.turns.map((turn) => ({
      speakerId: turn.speakerId,
      messages: turn.messages.map((message) => ({ kind: message.kind, text: message.text })),
    })),
  };
}

function requiredValidationContext(
  context: ReplyGenerationContext,
  allowedProfiles: ParticipantProfileContext[],
): ReplyGenerationContext {
  const profileTexts = new Set(context.participantProfiles.flatMap((profile) => [
    profile.value,
    ...(profile.conditions ?? []),
    ...(profile.exceptions ?? []),
  ]));
  return {
    ...context,
    participantProfiles: allowedProfiles,
    currentFacts: (context.currentFacts ?? []).filter((fact) => !profileTexts.has(fact)),
  };
}

function unverifiedProfileWarning(
  candidate: GeneratedReply["candidates"][number],
  inferenceOnly: boolean,
  allowedProfiles: ParticipantProfileContext[],
): ReplyWarning[] {
  if (!inferenceOnly) return [];
  const selectedIds = new Set(candidate.contextBasisIds);
  return allowedProfiles.some((profile) => (
    selectedIds.has(profile.id) && profile.source === "ai_inference"
  )) ? ["unverified_profile_context"] : [];
}

export class ReplyService {
  constructor(private readonly dependencies: ReplyServiceDependencies) {}

  async generateReplies(command: GenerateRepliesCommand): Promise<ReplyGenerationResult> {
    const preloadedProfiles = command.personalContextMode === "required"
      ? await this.dependencies.contextProvider.loadParticipantProfiles(command)
      : undefined;
    const requiredSelection = preloadedProfiles
      ? selectRequiredPersonalContext(preloadedProfiles)
      : null;
    if (requiredSelection && requiredSelection.facts.length === 0) {
      return { kind: "personal_context_unavailable", message: PERSONAL_CONTEXT_UNAVAILABLE_MESSAGE };
    }
    const context = await this.dependencies.contextProvider.load(command, preloadedProfiles);
    if (context.currentContext.needsUserQuestion) {
      return {
        kind: "clarification_required",
        question: context.currentContext.question
          ?? "지금 상황을 조금만 더 구체적으로 알려주실 수 있을까요?",
      };
    }

    const evidenceProfiles = requiredSelection?.facts ?? context.participantProfiles;
    const validationContext = requiredSelection
      ? requiredValidationContext(context, evidenceProfiles)
      : context;
    const memoryTexts = [
      context.roomMemory ?? "",
      ...evidenceProfiles.flatMap((profile) => [
        profile.value,
        ...(profile.conditions ?? []),
        ...(profile.exceptions ?? []),
      ]),
    ].filter(Boolean);
    const policy = buildStylePolicy({
      relationship: context.relationship,
      indirectness: command.indirectness,
      intent: command.intent,
      supportedDevices: supportedPersonalStyleDevices(memoryTexts),
    });
    const personalContextEvidence = buildPersonalContextEvidence(evidenceProfiles);
    const allowedFactIds = new Set(evidenceProfiles.map((profile) => profile.id));
    let validationRuleIds: ReplyValidationRuleId[] = [];

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let generated: GeneratedReply;
      try {
        generated = await this.dependencies.gateway.extract({
          purpose: "reply",
          schemaName: "woman_speech_reply_candidates",
          schema: generatedReplySchema,
          system: generationSystem(policy, command.personalContextMode === "required"),
          input: JSON.stringify({
            situation: command.situation,
            intent: command.intent,
            indirectness: command.indirectness,
            relationship: context.relationship,
            context: modelContext(
              validationContext,
              evidenceProfiles,
            ),
            personalContextEvidence,
            validationRuleIds,
          }),
        });
      } catch (error) {
        if (!(error instanceof ModelResponseValidationError)) throw error;
        validationRuleIds = ["OUTPUT_STRUCTURE"];
        if (attempt === 0) continue;
        throw new ReplyGenerationValidationError(validationRuleIds);
      }

      if (!hasExpectedStrategyOrder(generated.candidates)) {
        validationRuleIds = ["OUTPUT_STRUCTURE"];
        if (attempt === 0) continue;
        throw new ReplyGenerationValidationError(validationRuleIds);
      }

      const candidateContents: [
        ReplyCandidateContent,
        ReplyCandidateContent,
        ReplyCandidateContent,
      ] = [generated.candidates[0]!, generated.candidates[1]!, generated.candidates[2]!];
      const candidateValidationResults = await validateCandidates(
        candidateContents,
        command,
        validationContext,
        policy,
        this.dependencies.factValidator,
      );
      if (command.personalContextMode === "required") {
        const hasInvalidBasis = generated.candidates.some((candidate) => (
          invalidRequiredBasisIds(candidate.contextBasisIds, allowedFactIds)
        ));
        if (hasInvalidBasis) {
          validationRuleIds = ["REQUIRED_PERSONAL_CONTEXT_MISSING"];
          if (attempt === 0) continue;
          throw new ReplyGenerationValidationError(validationRuleIds);
        }
        const reflected = await this.dependencies.personalContextUsageValidator(
          semanticUsageCandidates([
            generated.candidates[0]!,
            generated.candidates[1]!,
            generated.candidates[2]!,
          ], evidenceProfiles),
          semanticUsageGrounding(command, validationContext),
        );
        if (generated.candidates.some((candidate) => !reflected[candidate.strategy])) {
          validationRuleIds = ["PERSONAL_CONTEXT_NOT_REFLECTED"];
          if (attempt === 0) continue;
          throw new ReplyGenerationValidationError(validationRuleIds);
        }
      }
      if (command.indirectness >= 6) {
        const candidates: [ReplyCandidate, ReplyCandidate, ReplyCandidate] = [
          withPublicCandidateMetadata(
            generated.candidates[0]!,
            personalContextEvidence,
            [
              "emotional_inference",
              ...candidateValidationResults[0]!.ruleIds.map(warningForRule),
              ...unverifiedProfileWarning(generated.candidates[0]!, requiredSelection?.inferenceOnly ?? false, evidenceProfiles),
            ],
          ),
          withPublicCandidateMetadata(
            generated.candidates[1]!,
            personalContextEvidence,
            [
              "emotional_inference",
              ...candidateValidationResults[1]!.ruleIds.map(warningForRule),
              ...unverifiedProfileWarning(generated.candidates[1]!, requiredSelection?.inferenceOnly ?? false, evidenceProfiles),
            ],
          ),
          withPublicCandidateMetadata(
            generated.candidates[2]!,
            personalContextEvidence,
            [
              "emotional_inference",
              ...candidateValidationResults[2]!.ruleIds.map(warningForRule),
              ...unverifiedProfileWarning(generated.candidates[2]!, requiredSelection?.inferenceOnly ?? false, evidenceProfiles),
            ],
          ),
        ];
        return { kind: "replies", candidates };
      }
      validationRuleIds = flattenValidationRuleIds(candidateValidationResults);
      if (validationRuleIds.length === 0) {
        const candidates: [ReplyCandidate, ReplyCandidate, ReplyCandidate] = [
          withPublicCandidateMetadata(
            generated.candidates[0]!,
            personalContextEvidence,
            unverifiedProfileWarning(generated.candidates[0]!, requiredSelection?.inferenceOnly ?? false, evidenceProfiles),
          ),
          withPublicCandidateMetadata(
            generated.candidates[1]!,
            personalContextEvidence,
            unverifiedProfileWarning(generated.candidates[1]!, requiredSelection?.inferenceOnly ?? false, evidenceProfiles),
          ),
          withPublicCandidateMetadata(
            generated.candidates[2]!,
            personalContextEvidence,
            unverifiedProfileWarning(generated.candidates[2]!, requiredSelection?.inferenceOnly ?? false, evidenceProfiles),
          ),
        ];
        return { kind: "replies", candidates };
      }
      if (attempt === 1) throw new ReplyGenerationValidationError(validationRuleIds);
    }

    throw new ReplyGenerationValidationError(["OUTPUT_STRUCTURE"]);
  }
}

export async function generateReplies(
  command: GenerateRepliesCommand,
  dependencies: ReplyServiceDependencies,
): Promise<ReplyGenerationResult> {
  return new ReplyService(dependencies).generateReplies(command);
}
