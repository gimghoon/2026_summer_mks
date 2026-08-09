import { requireSafePostgresTestUrl } from "../e2e/postgres-safety.mjs";

test("accepts only PostgreSQL URLs whose database name is explicitly marked test", () => {
  expect(requireSafePostgresTestUrl(
    "postgresql://tester:secret@127.0.0.1:5432/private_reply_e2e_test",
  )).toBe("postgresql://tester:secret@127.0.0.1:5432/private_reply_e2e_test");

  expect(() => requireSafePostgresTestUrl(undefined)).toThrow("E2E_DATABASE_URL is required");
  expect(() => requireSafePostgresTestUrl("mysql://localhost/private_reply_test"))
    .toThrow("must use postgres:// or postgresql://");
  expect(() => requireSafePostgresTestUrl("postgresql://localhost/private_reply_production"))
    .toThrow("Refusing PostgreSQL E2E");
  expect(() => requireSafePostgresTestUrl("postgresql://localhost/contest"))
    .toThrow("Refusing PostgreSQL E2E");
});
