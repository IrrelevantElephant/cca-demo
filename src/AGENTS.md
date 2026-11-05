# Go server and database

See [technical debt and pitfalls](../docs/TECHDEBT.md) for database configuration, packaging, migration, and runtime limitations.

## Runtime and API
- The Go module is rooted here, not at the repository root. It uses standard-library `net/http`, `database/sql`, and the `lib/pq` driver.
- `main.go` registers `GET /api/users` and task list, creation, detail, update, and deletion endpoints (`GET /api/tasks`, `POST /api/tasks`, `GET /api/tasks/{id}`, `PUT /api/tasks/{id}`, `DELETE /api/tasks/{id}`) and serves `./web/dist` from disk. Run the server with this directory as its working directory.
- `PUT /api/tasks/{id}` requires a single JSON object containing editable fields (`title`, `priority`, `assigned_to`, `status`, and optional string `description`; omitting `description` sets SQL `NULL` while the UI sends a string normalizing `null` to `""`), rejects immutable/unknown fields (`id`, `created_by`, `created_at`, `updated_at`, `seed_key`), updates `updated_at` to `CURRENT_TIMESTAMP`, and follows last-write-wins semantics across all six directed status transitions.
- `DELETE /api/tasks/{id}` validates positive PostgreSQL integer IDs, executes a single parameterized `DELETE FROM tasks WHERE id = $1`, and returns `204 No Content` with an empty body when a row is deleted or `404` JSON when no row matches.
- `PORT` defaults to 8080. Database access requires exactly `ConnectionString` (case-sensitive).
- `GET /api/users` returns an array of `{id, name, role}`, ordered by ID; no users should serialize as `[]`, not `null`.
- Application-generated API errors return JSON `{ "error", "message", "fields" }` (with optional `fields` map for validation failures). Preserve request-context SQL queries, resource cleanup, row iteration error checks, and generic client-facing database errors. Keep diagnostics server-side and never log connection strings.
- API logging middleware records method, path, response status, and duration for `/api/` requests.
- The current user selector is not authentication or authorization.

## Local workflow
From the repository root, start the complete stack with `docker compose -f src/docker-compose.yaml up --build`. Docker Compose waits for PostgreSQL health, runs the one-shot migrator, and only then starts the app. Stop with `docker compose -f src/docker-compose.yaml down` (do not use `-v` for ordinary development data).

For a host-run backend, with the Compose database running:
1. Build assets: `(cd src/web && pnpm install --frozen-lockfile && pnpm build)`.
2. Set `ConnectionString='postgresql://postgres:password@localhost:5432/cca-demo?sslmode=disable'`.
3. Apply the complete schema if needed: `psql "$ConnectionString" -v ON_ERROR_STOP=1 -1 -f src/database/schema.sql -f src/database/migrations/002_tasks.sql -f src/database/migrations/003_task_creation_constraints.sql`.
4. `cd src && go run .` (export the connection variable first).

Format changed Go files with `gofmt`; run `go test ./...` and `go vet ./...` here. To check compilation, use `go build -o /tmp/cca-demo .`.

## Schema changes
- The complete migration entry point is `database/schema.sql` followed by `database/migrations/002_tasks.sql` and `database/migrations/003_task_creation_constraints.sql`. `002_tasks.sql` records one-time demo task seeding in `seed_metadata` (`recoverboard:slice2:tasks`) so deleted demo tasks are not reinserted on subsequent migration replays.
- The Docker migration image executes both files through psql in one transaction with `ON_ERROR_STOP`, lock/statement timeouts, and a transaction-level advisory lock.
- Keep migrations repeatable and additive; do not drop/recreate existing application tables or remove user data.
- Keep predefined user upserts consistent between `database/schema.sql` and `database/seed.sql`.
- Test schema changes against a disposable local database, including a second run and preservation of unrelated existing rows.
- Schema changes must remain backward-compatible across the production rollout window; see `../docs/TECHDEBT.md`.
