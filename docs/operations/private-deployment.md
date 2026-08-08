# Private deployment runbook

This application is for one private account. It is not designed or reviewed as a public multi-user service. The server and configured model provider process decrypted text during analysis and reply generation, so this system is **not end-to-end encrypted**.

## 1. PostgreSQL and pgvector

Use a supported PostgreSQL release on a private network. Install the matching `pgvector` package, create a dedicated role/database, and enable the required extensions:

```sh
sudo -u postgres createuser --pwprompt private_reply_app
sudo -u postgres createdb --owner private_reply_app private_reply_assistant
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c 'CREATE EXTENSION IF NOT EXISTS vector;'
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto;'
```

Allow the application role to reach only this database. Keep PostgreSQL bound to a private interface, require TLS for remote database connections, and do not reuse its password for the app login.

## 2. Secrets and environment

Copy `.env.example` into the deployment secret manager. Generate two independent 32-byte keys; do not store either key in PostgreSQL or its backups:

```sh
openssl rand -base64 32
openssl rand -base64 32
```

Assign one output to `APP_ENCRYPTION_KEY` and the other to `SESSION_SIGNING_KEY`. Generate the single-user Argon2id password hash without writing the plaintext password to the env file:

```sh
read -s APP_LOGIN_PASSWORD
export APP_LOGIN_PASSWORD
node -e "require('@node-rs/argon2').hash(process.env.APP_LOGIN_PASSWORD).then(console.log)"
unset APP_LOGIN_PASSWORD
```

Set `APP_PASSWORD_HASH` to that command's output. Set `OPENAI_API_KEY`, then configure `ANALYSIS_MODEL`, `REPLY_MODEL`, and `EMBEDDING_MODEL` to provider models that support the required structured output and 1,536-dimensional embeddings. Confirm the provider's data-processing and retention terms before uploading private messages. The OpenAI adapter sends `store: false`, but that setting does not prevent the provider from processing plaintext.

## 3. Install, migrate, and start

Use Node.js 22 or later and the lockfile-selected pnpm version:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm exec drizzle-kit migrate
pnpm build
pnpm start
```

The migration itself runs `CREATE EXTENSION vector` and `CREATE EXTENSION pgcrypto`; the explicit extension checks above make privilege failures visible before the application is started. Verify the local process without disclosing configuration:

```sh
curl --fail --silent http://127.0.0.1:3000/api/health
```

Expected response: `{"status":"ok"}`.

## 4. HTTPS reverse proxy and request throttling

Never expose the Next.js process directly. Terminate HTTPS at a maintained reverse proxy, redirect HTTP to HTTPS, and preserve the application security headers. A minimal Nginx shape is:

```nginx
limit_req_zone $binary_remote_addr zone=login:10m rate=5r/m;
limit_req_zone $binary_remote_addr zone=private_api:10m rate=30r/m;

server {
  listen 443 ssl http2;
  server_name private-reply.example.com;
  ssl_certificate /etc/letsencrypt/live/private-reply.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/private-reply.example.com/privkey.pem;

  location = /api/session {
    limit_req zone=login burst=5 nodelay;
    proxy_pass http://127.0.0.1:3000;
  }

  location /api/ {
    limit_req zone=private_api burst=20 nodelay;
    client_max_body_size 51m;
    proxy_pass http://127.0.0.1:3000;
  }

  location / {
    proxy_pass http://127.0.0.1:3000;
  }
}
```

Keep the app's built-in limits as the final boundary: login 8 KiB, profile/correction 64 KiB, reply JSON 512 KiB with at most 50,000 pasted characters, and imports 50 MiB inside a bounded multipart request. Distributed deployments need a shared proxy or gateway limiter; an in-process counter is not sufficient.

## 5. Backups and restore test

Application-layer encryption protects message/profile/reply text in normal table rows, but database metadata, vector embeddings, and operational backups still require infrastructure protection. Encrypt every backup before it leaves the database host. With `age`:

```sh
pg_dump --format=custom --no-owner "$DATABASE_URL" | age -r "$AGE_BACKUP_RECIPIENT" > private-reply-$(date +%F).dump.age
```

At least quarterly, restore into an isolated scratch database and run the schema/count checks:

```sh
createdb private_reply_restore_test
age --decrypt -i "$AGE_IDENTITY_FILE" private-reply-YYYY-MM-DD.dump.age | pg_restore --exit-on-error --no-owner --dbname private_reply_restore_test
psql private_reply_restore_test -v ON_ERROR_STOP=1 -c '\dt'
dropdb private_reply_restore_test
```

Restrict backup and key access to separate principals. Rotate backups according to the same retention/deletion policy as the source data; deleting a live room does not retroactively alter an immutable old backup.

## 6. Delete verification

Delete a room from its private room page, record its UUID before deletion, then verify the foreign-key cascades with a read-only database session:

```sql
SELECT count(*) FROM rooms WHERE id = :'room_id';
SELECT count(*) FROM participants WHERE room_id = :'room_id';
SELECT count(*) FROM messages WHERE room_id = :'room_id';
SELECT count(*) FROM turns WHERE room_id = :'room_id';
SELECT count(*) FROM chunks WHERE room_id = :'room_id';
SELECT count(*) FROM room_memories WHERE room_id = :'room_id';
SELECT count(*) FROM reply_requests WHERE room_id = :'room_id';
SELECT count(*)
FROM reply_candidates c
JOIN reply_requests r ON r.id = c.reply_request_id
WHERE r.room_id = :'room_id';
```

Every count must be zero. Profile facts and revisions cascade through deleted participants; verify them before deletion by recording the participant IDs if an explicit audit is required. Also verify the room URL returns 404 and inspect structured application logs for only scalar operational identifiers—never names, message text, profile text, prompts, or model output.

## 7. Routine verification

Run before deployment and after dependency/model changes:

```sh
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm exec tsc --noEmit
pnpm build
```

The ordinary E2E suite starts an explicit non-production encrypted in-memory adapter, so it does not require PostgreSQL, OpenAI, or network access. Production mode cannot enable that adapter. Separately schedule a staging smoke test against PostgreSQL and the configured models; never use real private conversations as staging fixtures.
