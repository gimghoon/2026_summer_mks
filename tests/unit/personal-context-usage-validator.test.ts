import { expect, test } from "vitest";

import type { StructuredModelRequest } from "@/domain/models/gateway";
import { ModelResponseValidationError } from "@/domain/models/gateway";
import {
  createPersonalContextUsageValidator,
  type PersonalContextUsageCandidate,
} from "@/domain/replies/personal-context-usage-validator";

const candidates: [
  PersonalContextUsageCandidate,
  PersonalContextUsageCandidate,
  PersonalContextUsageCandidate,
] = [
  {
    strategy: "relationship_soft",
    text: "바빴구나, 다음엔 한마디만 해줘",
    selectedFacts: [{ id: "fact-a", kind: "speech", value: "짧게 답한다", conditions: [], exceptions: [] }],
  },
  {
    strategy: "emotion_signal",
    text: "기다리면서 조금 아쉬웠어",
    selectedFacts: [{ id: "fact-b", kind: "preference", value: "직설적인 말은 부담스럽다", conditions: [], exceptions: [] }],
  },
  {
    strategy: "clearer_request",
    text: "늦을 땐 미리 알려줘",
    selectedFacts: [{ id: "fact-c", kind: "boundary", value: "미리 알림을 원한다", conditions: [], exceptions: [] }],
  },
];

const grounding = {
  situation: "답이 늦어서 조금 서운하다",
  intent: "다음에는 미리 알려 달라고 요청한다",
  currentTurns: [{
    speakerId: "participant-1",
    messages: [{ kind: "text" as const, text: "오늘 답이 늦어서 미안해" }],
  }],
};

test("checks all three selected-fact uses in one ordered extraction", async () => {
  const requests: StructuredModelRequest<unknown>[] = [];
  const validator = createPersonalContextUsageValidator({
    async extract<T>(request: StructuredModelRequest<T>): Promise<T> {
      requests.push(request as StructuredModelRequest<unknown>);
      return request.schema.parse({
        candidates: [
          { strategy: "relationship_soft", reflected: true },
          { strategy: "emotion_signal", reflected: false },
          { strategy: "clearer_request", reflected: true },
        ],
      });
    },
  });

  await expect(validator(candidates, grounding)).resolves.toEqual({
    relationship_soft: true,
    emotion_signal: false,
    clearer_request: true,
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ purpose: "reply", schemaName: "personal_context_usage_check" });
  expect(JSON.parse(requests[0]!.input)).toEqual({ candidates, grounding });
  expect(requests[0]!.system).toContain("not grounded");
  expect(requests[0]!.system).toContain("false");
  expect(requests[0]!.input).not.toContain("retrievedHistory");
  expect(requests[0]!.input).not.toContain("roomMemory");
});

test("rejects a syntactically valid response with strategies in the wrong order", async () => {
  const validator = createPersonalContextUsageValidator({
    async extract<T>(): Promise<T> {
      return {
        candidates: [
          { strategy: "emotion_signal", reflected: true },
          { strategy: "relationship_soft", reflected: true },
          { strategy: "clearer_request", reflected: true },
        ],
      } as T;
    },
  });

  await expect(validator(candidates, grounding)).rejects.toBeInstanceOf(ModelResponseValidationError);
});
