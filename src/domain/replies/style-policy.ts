import type { RelationshipStyle } from "@/db/schema";

export type IndirectnessLevel = 1 | 2 | 3 | 4 | 5;

export const personalStyleDevices = [
  "laughter",
  "vowel_repetition",
  "tilde",
  "emoji",
] as const;

export type PersonalStyleDevice = typeof personalStyleDevices[number];

export type StylePolicyInput = {
  relationship: RelationshipStyle;
  indirectness: IndirectnessLevel;
  intent: string;
  supportedDevices?: PersonalStyleDevice[];
};

export type StylePolicy = {
  indirectness: IndirectnessLevel;
  relationship: RelationshipStyle;
  forbiddenCues: string[];
  allowedDevices: string[];
  mustRemainExplicit: boolean;
};

const levelDevices: Record<IndirectnessLevel, string[]> = {
  1: ["direct_emotion", "direct_request", "brief_acknowledgement"],
  2: ["softened_emotion", "brief_situation", "gentle_suggestion"],
  3: ["situation_description", "hedged_question", "gentle_suggestion", "sentence_fragment"],
  4: ["situation_description", "hedged_question", "pause", "emotion_clue", "gentle_suggestion"],
  5: ["situation_description", "hedged_question", "pause", "implication", "emotion_clue"],
};

const alwaysForbidden = [
  "invented_fact",
  "coercion",
  "harassment",
  "threat",
  "shaming",
  "guilt_tripping",
  "conflict_escalation",
] as const;

const friendForbidden = [
  "romantic_affection",
  "jealousy",
  "exclusive_possession",
] as const;

const explicitIntentPatterns = [
  /(?:^|[_\s-])(consent|safety|money|payment|loan|debt|firm[_-]?rejection|firm[_-]?refusal|important[_-]?promise)(?:$|[_\s-])/iu,
  /동의|성적\s*접촉|스킨십|키스|만지/iu,
  /안전|위험|응급|긴급|신고|귀가/iu,
  /돈|금전|송금|입금|대출|빚|빌려|계좌|결제|환불/iu,
  /단호한?\s*거절|확실한?\s*거절|거부|선\s*긋/iu,
  /중요한?\s*약속|계약|예약|마감/iu,
] as const;

function assertPolicyInput(input: StylePolicyInput): void {
  if (input.relationship !== "female_friend" && input.relationship !== "girlfriend") {
    throw new Error("relationship must be female_friend or girlfriend");
  }
  if (![1, 2, 3, 4, 5].includes(input.indirectness)) {
    throw new RangeError("indirectness must be an integer from 1 through 5");
  }
}

export function isExplicitIntent(intent: string): boolean {
  const normalized = intent.normalize("NFKC").trim();
  return explicitIntentPatterns.some((pattern) => pattern.test(normalized));
}

function memoryAffirms(memory: string, cue: RegExp): boolean {
  return memory.split(/[\n.!?]+/u).some((statement) => (
    cue.test(statement)
    && !/(?:안\s*(?:씀|쓴|써|사용)|쓰지\s*않|사용하지\s*않|못\s*(?:씀|쓴|써|사용)|금지|거의\s*없)/u.test(statement)
  ));
}

/**
 * Finds personal chat devices only when reviewed room or participant memory says
 * they are normal for this relationship. It never infers them from demographics.
 */
export function supportedPersonalStyleDevices(memoryTexts: string[]): PersonalStyleDevice[] {
  const memory = memoryTexts.join("\n").normalize("NFKC");
  const supported: PersonalStyleDevice[] = [];
  if (memoryAffirms(memory, /(?:ㅋㅋ|ㅎㅎ|ᄏᄏ|ᄒᄒ|웃음\s*표현|laugh)/iu)) supported.push("laughter");
  if (memoryAffirms(memory, /(?:모음\s*반복|vowel\s*repetition|[아야어여오요우유으이]{3,})/iu)) {
    supported.push("vowel_repetition");
  }
  if (memoryAffirms(memory, /(?:[~～]|물결\s*(?:표|기호)|tilde)/iu)) supported.push("tilde");
  if (memoryAffirms(memory, /(?:\p{Extended_Pictographic}|이모지|이모티콘|emoji)/u)) supported.push("emoji");
  return supported;
}

/** Builds deterministic, relationship-bounded rules for the opt-in woman-speech style. */
export function buildStylePolicy(input: StylePolicyInput): StylePolicy {
  assertPolicyInput(input);
  const supported = new Set(input.supportedDevices ?? []);
  const allowedPersonalDevices = personalStyleDevices.filter((device) => supported.has(device));

  return {
    indirectness: input.indirectness,
    relationship: input.relationship,
    forbiddenCues: [
      ...alwaysForbidden,
      ...(input.relationship === "female_friend" ? friendForbidden : []),
    ],
    allowedDevices: [...levelDevices[input.indirectness], ...allowedPersonalDevices],
    mustRemainExplicit: isExplicitIntent(input.intent),
  };
}
