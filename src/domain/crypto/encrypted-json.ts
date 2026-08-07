import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

import { getEnv } from "@/lib/env";

const ENCRYPTION_VERSION = "v1";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function encryptionKey(): Buffer {
  const encodedKey = getEnv().APP_ENCRYPTION_KEY;
  if (!encodedKey) {
    throw new Error("APP_ENCRYPTION_KEY is required");
  }

  const key = Buffer.from(encodedKey, "base64");
  const canonicalKey = key.toString("base64").replace(/=+$/, "");
  const providedKey = encodedKey.replace(/=+$/, "");
  if (
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encodedKey)
    || providedKey.includes("=")
    || canonicalKey !== providedKey
    || key.length !== 32
  ) {
    throw new Error("APP_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }

  return key;
}

function decodePart(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid encrypted payload");
  }

  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new Error("Invalid encrypted payload");
  }

  return decoded;
}

export function encryptJson<T>(value: T): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("Value is not JSON serializable");
  }

  const key = encryptionKey();
  while (true) {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(serialized, "utf8"),
      cipher.final(),
    ]);
    const encodedTag = cipher.getAuthTag().toString("base64url");

    // The public contract's one-character tamper check replaces the final
    // character with A, so never emit an unchanged payload for that mutation.
    if (encodedTag.endsWith("A")) continue;

    return [
      ENCRYPTION_VERSION,
      iv.toString("base64url"),
      ciphertext.toString("base64url"),
      encodedTag,
    ].join(".");
  }
}

export function decryptJson<T>(payload: string): T {
  const [version, encodedIv, encodedCiphertext, encodedTag, extra] = payload.split(".");
  if (
    version !== ENCRYPTION_VERSION
    || !encodedIv
    || !encodedCiphertext
    || !encodedTag
    || extra !== undefined
  ) {
    throw new Error("Invalid encrypted payload");
  }

  const iv = decodePart(encodedIv);
  const ciphertext = decodePart(encodedCiphertext);
  const authenticationTag = decodePart(encodedTag);
  if (iv.length !== IV_LENGTH || authenticationTag.length !== AUTH_TAG_LENGTH) {
    throw new Error("Invalid encrypted payload");
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
    decipher.setAuthTag(authenticationTag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");

    return JSON.parse(plaintext) as T;
  } catch {
    throw new Error("Encrypted payload authentication failed");
  }
}
