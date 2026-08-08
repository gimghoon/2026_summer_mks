import { z } from "zod";

import { ModelResponseValidationError } from "@/domain/models/gateway";
import {
  OpenAIModelGateway,
  type OpenAIClientLike,
} from "@/domain/models/openai-gateway";

const gatewayEnv = {
  ANALYSIS_MODEL: "analysis-test-model",
  REPLY_MODEL: "reply-test-model",
  EMBEDDING_MODEL: "embedding-test-model",
};

function createClient() {
  const responsesCreate = vi.fn<OpenAIClientLike["responses"]["create"]>();
  const embeddingsCreate = vi.fn<OpenAIClientLike["embeddings"]["create"]>();
  const client: OpenAIClientLike = {
    responses: { create: responsesCreate },
    embeddings: { create: embeddingsCreate },
  };
  return { client, responsesCreate, embeddingsCreate };
}

test("uses the analysis model and strict structured output format", async () => {
  const { client, responsesCreate } = createClient();
  responsesCreate.mockResolvedValue({ output_text: JSON.stringify({ topic: "약속" }) });
  const gateway = new OpenAIModelGateway({ client, env: gatewayEnv });

  const result = await gateway.extract({
    system: "Summarize safely",
    input: "Conversation input",
    schemaName: "conversation_topic",
    schema: z.object({ topic: z.string() }),
  });

  expect(result).toEqual({ topic: "약속" });
  expect(responsesCreate).toHaveBeenCalledWith(expect.objectContaining({
    model: "analysis-test-model",
    instructions: "Summarize safely",
    input: "Conversation input",
    store: false,
    text: {
      format: expect.objectContaining({
        type: "json_schema",
        name: "conversation_topic",
        strict: true,
      }),
    },
  }));
});

test.each([
  ["invalid JSON", "PRIVATE_RESPONSE_TEXT"],
  ["schema mismatch", JSON.stringify({ topic: 42, private: "PRIVATE_RESPONSE_TEXT" })],
])("returns a prompt-free validation error for %s", async (_caseName, outputText) => {
  const { client, responsesCreate } = createClient();
  responsesCreate.mockResolvedValue({ output_text: outputText });
  const gateway = new OpenAIModelGateway({ client, env: gatewayEnv });

  try {
    await gateway.extract({
      system: "PRIVATE_SYSTEM_PROMPT",
      input: "PRIVATE_INPUT_TEXT",
      schemaName: "conversation_topic",
      schema: z.object({ topic: z.string() }),
    });
    expect.unreachable("invalid model output must be rejected");
  } catch (error) {
    expect(error).toBeInstanceOf(ModelResponseValidationError);
    expect(String(error)).not.toMatch(/PRIVATE_SYSTEM_PROMPT|PRIVATE_INPUT_TEXT|PRIVATE_RESPONSE_TEXT/);
  }
});

test.each([429, 503])("retries status %i once", async (status) => {
  const { client, responsesCreate } = createClient();
  responsesCreate
    .mockRejectedValueOnce(Object.assign(new Error("temporary"), { status }))
    .mockResolvedValueOnce({ output_text: JSON.stringify({ topic: "재시도 성공" }) });
  const gateway = new OpenAIModelGateway({ client, env: gatewayEnv });

  await expect(gateway.extract({
    system: "system",
    input: "input",
    schemaName: "conversation_topic",
    schema: z.object({ topic: z.string() }),
  })).resolves.toEqual({ topic: "재시도 성공" });
  expect(responsesCreate).toHaveBeenCalledTimes(2);
});

test("does not retry non-transient failures", async () => {
  const { client, responsesCreate } = createClient();
  const failure = Object.assign(new Error("bad request"), { status: 400 });
  responsesCreate.mockRejectedValue(failure);
  const gateway = new OpenAIModelGateway({ client, env: gatewayEnv });

  await expect(gateway.extract({
    system: "system",
    input: "input",
    schemaName: "conversation_topic",
    schema: z.object({ topic: z.string() }),
  })).rejects.toBe(failure);
  expect(responsesCreate).toHaveBeenCalledTimes(1);
});

test("stops after one retry when transient failures continue", async () => {
  const { client, responsesCreate } = createClient();
  const failure = Object.assign(new Error("still unavailable"), { status: 503 });
  responsesCreate.mockRejectedValue(failure);
  const gateway = new OpenAIModelGateway({ client, env: gatewayEnv });

  await expect(gateway.extract({
    system: "system",
    input: "input",
    schemaName: "conversation_topic",
    schema: z.object({ topic: z.string() }),
  })).rejects.toBe(failure);
  expect(responsesCreate).toHaveBeenCalledTimes(2);
});

test("requires every configured model name", () => {
  const { client } = createClient();

  expect(() => new OpenAIModelGateway({
    client,
    env: { ...gatewayEnv, REPLY_MODEL: undefined },
  })).toThrow("REPLY_MODEL is required");
});

test("batches embeddings in groups of exactly sixty-four and preserves input order", async () => {
  const { client, embeddingsCreate } = createClient();
  embeddingsCreate.mockImplementation(async ({ input }) => {
    const batch = input as string[];
    return {
      data: batch.map((text, index) => ({
        object: "embedding" as const,
        index,
        embedding: [Number(text.slice(5))],
      })).reverse(),
    };
  });
  const gateway = new OpenAIModelGateway({ client, env: gatewayEnv });
  const texts = Array.from({ length: 129 }, (_, index) => `text-${index}`);

  const result = await gateway.embed(texts);

  expect(embeddingsCreate).toHaveBeenCalledTimes(3);
  expect(embeddingsCreate.mock.calls.map(([request]) => (request.input as string[]).length)).toEqual([
    64,
    64,
    1,
  ]);
  expect(embeddingsCreate.mock.calls[0]![0]).toMatchObject({
    model: "embedding-test-model",
    encoding_format: "float",
  });
  expect(result).toEqual(Array.from({ length: 129 }, (_, index) => [index]));
});

test("does not call the embedding provider for an empty input", async () => {
  const { client, embeddingsCreate } = createClient();
  const gateway = new OpenAIModelGateway({ client, env: gatewayEnv });

  await expect(gateway.embed([])).resolves.toEqual([]);
  expect(embeddingsCreate).not.toHaveBeenCalled();
});
