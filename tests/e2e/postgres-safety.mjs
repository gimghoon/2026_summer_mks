const TEST_DATABASE_MARKER = /(?:^|[_-])test(?:[_-]|$)/iu;

/** @param {string | undefined} value */
export function requireSafePostgresTestUrl(value) {
  if (!value) {
    throw new Error("E2E_DATABASE_URL is required for PostgreSQL deletion E2E");
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("E2E_DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("E2E_DATABASE_URL must use postgres:// or postgresql://");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, ""));
  if (!databaseName || !TEST_DATABASE_MARKER.test(databaseName)) {
    throw new Error(
      "Refusing PostgreSQL E2E: database name must contain a standalone test marker (for example private_reply_e2e_test)",
    );
  }
  return value;
}
