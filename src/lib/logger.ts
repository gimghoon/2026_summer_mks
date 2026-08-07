const UNSAFE_METADATA_KEY = /text|message|content|name|profile|prompt/i;

type LogMetadata = Record<string, string | number | boolean>;

export function safeLog(event: string, metadata: LogMetadata): void {
  for (const [key, value] of Object.entries(metadata)) {
    if (UNSAFE_METADATA_KEY.test(key)) {
      throw new Error(`Unsafe log metadata key: ${key}`);
    }
    if (
      typeof value !== "string"
      && typeof value !== "number"
      && typeof value !== "boolean"
    ) {
      throw new Error(`Unsafe log metadata value: ${key}`);
    }
  }

  console.info(JSON.stringify({ event, metadata }));
}
