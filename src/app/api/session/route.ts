import { InvalidPasswordError, createSessionCookie } from "@/domain/auth/session";
import { readBoundedText } from "@/lib/http/request-body";

const MAX_LOGIN_REQUEST_BYTES = 8 * 1024;

async function submittedPassword(request: Request): Promise<
  { ok: true; password: string | null } | { ok: false; tooLarge: boolean }
> {
  const body = await readBoundedText(request, MAX_LOGIN_REQUEST_BYTES);
  if (!body.ok) return { ok: false, tooLarge: body.error === "too_large" };
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(body.value) as { password?: unknown };
      return { ok: true, password: typeof parsed.password === "string" ? parsed.password : null };
    } catch {
      return { ok: false, tooLarge: false };
    }
  }

  if (!contentType.includes("application/x-www-form-urlencoded")) {
    return { ok: false, tooLarge: false };
  }
  const password = new URLSearchParams(body.value).get("password");
  return { ok: true, password };
}

export async function POST(request: Request): Promise<Response> {
  const submission = await submittedPassword(request);
  if (!submission.ok) {
    return new Response(
      submission.tooLarge ? "Login request is too large" : "Invalid login request",
      { status: submission.tooLarge ? 413 : 400 },
    );
  }
  if (submission.password === null) {
    return new Response("Password is required", { status: 400 });
  }

  try {
    const sessionCookie = await createSessionCookie(submission.password);
    return new Response(null, {
      status: 303,
      headers: {
        location: new URL("/", request.url).toString(),
        "set-cookie": sessionCookie,
      },
    });
  } catch (error) {
    if (error instanceof InvalidPasswordError) {
      return new Response("Unauthorized", { status: 401 });
    }
    throw error;
  }
}
