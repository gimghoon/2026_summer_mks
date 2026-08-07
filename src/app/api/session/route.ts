import { InvalidPasswordError, createSessionCookie } from "@/domain/auth/session";

async function submittedPassword(request: Request): Promise<string | null> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = await request.json() as { password?: unknown };
    return typeof body.password === "string" ? body.password : null;
  }

  const body = await request.formData();
  const password = body.get("password");
  return typeof password === "string" ? password : null;
}

export async function POST(request: Request): Promise<Response> {
  const password = await submittedPassword(request);
  if (password === null) {
    return new Response("Password is required", { status: 400 });
  }

  try {
    const sessionCookie = await createSessionCookie(password);
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
