import { err, ok, type Result } from "@/lib/result";

export type RequestBodyFailure = "invalid" | "too_large";

function declaredBodyIsTooLarge(request: Request, maxBytes: number): boolean {
  const contentLength = request.headers.get("content-length");
  return Boolean(contentLength && /^\d+$/u.test(contentLength) && Number(contentLength) > maxBytes);
}

export async function readBoundedText(
  request: Request,
  maxBytes: number,
): Promise<Result<string, RequestBodyFailure>> {
  if (declaredBodyIsTooLarge(request, maxBytes)) return err("too_large");
  if (!request.body) return err("invalid");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        return err("too_large");
      }
      chunks.push(value);
    }
  } catch {
    return err("invalid");
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return ok(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return err("invalid");
  }
}

export async function readBoundedJson(
  request: Request,
  maxBytes: number,
): Promise<Result<unknown, RequestBodyFailure>> {
  const text = await readBoundedText(request, maxBytes);
  if (!text.ok) return text;
  try {
    return ok(JSON.parse(text.value) as unknown);
  } catch {
    return err("invalid");
  }
}
