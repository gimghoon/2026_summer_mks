import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { CreateEmbeddingResponse, EmbeddingCreateParams } from "openai/resources/embeddings";
import type {
  Response,
  ResponseCreateParamsNonStreaming,
} from "openai/resources/responses/responses";

import {
  ModelResponseValidationError,
  type ModelGateway,
  type StructuredModelRequest,
} from "@/domain/models/gateway";
import { getEnv, type AppEnv } from "@/lib/env";

const EMBEDDING_BATCH_SIZE = 64;

type GatewayEnvironment = Pick<
  AppEnv,
  "OPENAI_API_KEY" | "ANALYSIS_MODEL" | "REPLY_MODEL" | "EMBEDDING_MODEL"
>;

export type OpenAIClientLike = {
  responses: {
    create(request: ResponseCreateParamsNonStreaming): Promise<Pick<Response, "output_text">>;
  };
  embeddings: {
    create(request: EmbeddingCreateParams): Promise<Pick<CreateEmbeddingResponse, "data">>;
  };
};

export type OpenAIModelGatewayOptions = {
  client?: OpenAIClientLike;
  env?: GatewayEnvironment;
};

function requiredSetting(value: string | undefined, name: keyof GatewayEnvironment): string {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function isRetryable(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return false;
  }

  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && (status === 429 || (status >= 500 && status <= 599));
}

async function withOneRetry<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isRetryable(error)) {
      throw error;
    }
    return operation();
  }
}

export class OpenAIModelGateway implements ModelGateway {
  private readonly client: OpenAIClientLike;
  private readonly analysisModel: string;
  private readonly replyModel: string;
  private readonly embeddingModel: string;

  constructor(options: OpenAIModelGatewayOptions = {}) {
    const env = options.env ?? getEnv();

    this.analysisModel = requiredSetting(env.ANALYSIS_MODEL, "ANALYSIS_MODEL");
    this.replyModel = requiredSetting(env.REPLY_MODEL, "REPLY_MODEL");
    this.embeddingModel = requiredSetting(env.EMBEDDING_MODEL, "EMBEDDING_MODEL");
    this.client = options.client ?? new OpenAI({
      apiKey: requiredSetting(env.OPENAI_API_KEY, "OPENAI_API_KEY"),
      maxRetries: 0,
    });
  }

  async extract<T>(request: StructuredModelRequest<T>): Promise<T> {
    const response = await withOneRetry(() => this.client.responses.create({
      model: this.analysisModel,
      instructions: request.system,
      input: request.input,
      text: {
        format: zodTextFormat(request.schema, request.schemaName),
      },
      store: false,
    }));

    try {
      const decoded: unknown = JSON.parse(response.output_text);
      const result = request.schema.safeParse(decoded);
      if (!result.success) {
        throw new ModelResponseValidationError();
      }
      return result.data;
    } catch (error) {
      if (error instanceof ModelResponseValidationError) {
        throw error;
      }
      throw new ModelResponseValidationError();
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    const embeddings: number[][] = [];

    for (let start = 0; start < texts.length; start += EMBEDDING_BATCH_SIZE) {
      const input = texts.slice(start, start + EMBEDDING_BATCH_SIZE);
      const response = await withOneRetry(() => this.client.embeddings.create({
        model: this.embeddingModel,
        input,
        encoding_format: "float",
      }));
      const ordered = [...response.data].sort((left, right) => left.index - right.index);
      embeddings.push(...ordered.map((item) => item.embedding));
    }

    return embeddings;
  }
}
