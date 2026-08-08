import type { z } from "zod";

export type StructuredModelRequest<T> = {
  system: string;
  input: string;
  schemaName: string;
  schema: z.ZodType<T>;
};

export interface ModelGateway {
  extract<T>(request: StructuredModelRequest<T>): Promise<T>;
  embed(texts: string[]): Promise<number[][]>;
}

export class ModelResponseValidationError extends Error {
  constructor() {
    super("Model response failed schema validation");
    this.name = "ModelResponseValidationError";
  }
}
