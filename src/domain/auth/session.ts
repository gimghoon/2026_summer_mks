import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { verify } from "@node-rs/argon2";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { getEnv } from "@/lib/env";

const SESSION_COOKIE_NAME = "private_reply_session";
const SESSION_DURATION_SECONDS = 12 * 60 * 60;
const SESSION_VERSION = "v1";

export class InvalidPasswordError extends Error {
  constructor() {
    super("Invalid password");
    this.name = "InvalidPasswordError";
  }
}

function signingKey(): Buffer {
  const encodedKey = getEnv().SESSION_SIGNING_KEY;
  if (!encodedKey) {
    throw new Error("SESSION_SIGNING_KEY is required");
  }
  return Buffer.from(encodedKey, "base64");
}

function sign(value: string): string {
  return createHmac("sha256", signingKey()).update(value).digest("base64url");
}

function createToken(expiresAt: number): string {
  const unsigned = [
    SESSION_VERSION,
    String(expiresAt),
    randomBytes(16).toString("base64url"),
  ].join(".");
  return `${unsigned}.${sign(unsigned)}`;
}

function validToken(token: string | undefined): boolean {
  if (!token) return false;

  const [version, expiresAtValue, nonce, signature, extra] = token.split(".");
  if (
    version !== SESSION_VERSION
    || !expiresAtValue
    || !nonce
    || !signature
    || extra !== undefined
  ) {
    return false;
  }

  const expiresAt = Number(expiresAtValue);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) {
    return false;
  }

  const unsigned = [version, expiresAtValue, nonce].join(".");
  const expected = Buffer.from(sign(unsigned), "base64url");
  const actual = Buffer.from(signature, "base64url");
  return signature === actual.toString("base64url")
    && actual.length === expected.length
    && timingSafeEqual(actual, expected);
}

function cookieFromHeader(header: string | null): string | undefined {
  if (!header) return undefined;

  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator === -1) continue;
    const name = item.slice(0, separator).trim();
    if (name !== SESSION_COOKIE_NAME) continue;

    const value = item.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return undefined;
    }
  }

  return undefined;
}

export async function createSessionCookie(password: string): Promise<string> {
  const passwordHash = getEnv().APP_PASSWORD_HASH;
  if (!passwordHash) {
    throw new Error("APP_PASSWORD_HASH is required");
  }

  let passwordMatches = false;
  if (passwordHash.startsWith("$argon2id$")) {
    try {
      passwordMatches = await verify(passwordHash, password);
    } catch {
      passwordMatches = false;
    }
  }

  if (!passwordMatches) {
    throw new InvalidPasswordError();
  }

  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_DURATION_SECONDS;
  const token = createToken(expiresAt);
  const expires = new Date(expiresAt * 1000).toUTCString();
  return [
    `${SESSION_COOKIE_NAME}=${token}`,
    "Path=/",
    `Max-Age=${SESSION_DURATION_SECONDS}`,
    `Expires=${expires}`,
    "Secure",
    "HttpOnly",
    "SameSite=Strict",
  ].join("; ");
}

export async function requireSession(request?: Request): Promise<void> {
  const token = request
    ? cookieFromHeader(request.headers.get("cookie"))
    : (await cookies()).get(SESSION_COOKIE_NAME)?.value;

  if (validToken(token)) return;

  if (request) {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      throw new Response("Unauthorized", { status: 401 });
    }
    throw Response.redirect(new URL("/login", url), 307);
  }

  redirect("/login");
}
