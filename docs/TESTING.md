# RecoverBoard browser testing

Tests use one TypeScript Playwright project, `Dockerfile.playwright`, and pinned Microsoft Chromium image/package (`1.51.1`). Integration tests exercise the real React static bundle, Go API and PostgreSQL. The test overlay assigns an isolated Compose project/database volume, removes host port mappings, and leaves normal development data untouched. Smoke tests use the same runner against a supplied URL.

## Local application workflow

Docker and Compose are the only host requirements for the app stack. From the repository root:

```sh
docker compose -f src/docker-compose.yaml up --build
```

PostgreSQL health gates the one-shot migration (`schema.sql`, `002_tasks.sql`, and `003_task_creation_constraints.sql`), whose successful completion gates app startup. Stop with `docker compose -f src/docker-compose.yaml down`; do not add `-v` because the development database persists. Inspect logs with `docker compose -f src/docker-compose.yaml logs -f app database migrator`. Compose watch rebuilds the app when source changes; use `up --build` for an explicit rebuild.

## Integration tests

Start the isolated app stack detached, then run the existing Playwright service. This allows the successful one-shot migration to exit without stopping the runner. Always collect logs and clean the isolated database volume, preserving the test/setup status:

```sh
status=0
docker compose -p recoverboard-test -f src/docker-compose.yaml -f compose.test.yaml --profile integration up --build -d app || status=$?
if [ "$status" -eq 0 ]; then
  docker compose -p recoverboard-test -f src/docker-compose.yaml -f compose.test.yaml --profile integration run --build --no-deps --rm playwright npm run test:integration || status=$?
fi
if [ "$status" -eq 0 ]; then
  bash scripts/test-task-persistence.sh recoverboard-test || status=$?
fi
docker compose -p recoverboard-test -f src/docker-compose.yaml -f compose.test.yaml --profile integration logs > integration-compose.log || true
docker compose -p recoverboard-test -f src/docker-compose.yaml -f compose.test.yaml --profile integration down -v --remove-orphans
exit "$status"
```

For one test, append `-- --grep 'persists selection'` to `npm run test:integration`. The test project removes host ports and uses disposable named volumes; `down -v` applies only to that project.

## Smoke tests and reports

Smoke tests only start the runner and target the supplied deployed URL; `--no-deps` prevents the app/database from starting. They alter browser local storage only and never mutate deployed task data (`smoke/task-creation.spec.ts` and `smoke/tasks.spec.ts` exercise creation, details/edit dialog defaults, delete confirmation and cancellation, quick status availability, client-side task filtering and `Clear Filters`, and invalid-only form validation under a fail-closed non-GET route guard):

```sh
BASE_URL=https://recoverboard.example.com docker compose -p recoverboard-smoke -f src/docker-compose.yaml -f compose.test.yaml run --build --no-deps --rm -e PW_SUITE=smoke -e BASE_URL playwright npm run test:smoke
```

Reports are under `artifacts/playwright/` (HTML, JUnit, traces/screenshots). CI uploads them on failure as well as success. Integration covers startup, API contracts, selection persistence, board rendering/refresh, client-side task filtering (single/combined filters, `Clear Filters`, filtered column counts, empty filtered results, and filtering across task creation/editing/reassignment/status transitions/deletion/refresh), end-to-end task creation, task details editing, reassignment, all six status transitions, and permanent task deletion with confirmation; smoke checks availability, API shape, task detail retrieval, user selection, non-destructive task filtering, and non-destructive creation/editing/deletion-confirmation dialog validation. Core integration and smoke tests use the real application/API/database. Only `task-resilience.spec.ts`, `task-validation.spec.ts`, and the narrow failure-recovery tests inside `task-fixture.spec.ts` intercept requests to exercise frontend loading, malformed-read defenses, definite rejection retry, uncertain connection loss, and post-save/post-delete refresh or stale-GET handling; this does not replace real-stack contract coverage.

### Isolated SQL fixture and persistence gate

The test overlay also starts `fixture-app`, `fixture-migrator` and `fixture-database` as dependencies of the integration app. They reuse the production images with a separate disposable volume and no host ports. Only the serial `task-fixture.spec.ts` targets this fixture, leaving the primary `app` service untouched so ordinary regression specs can assert exact seeded snapshots and counts. Its SQL helper (`helpers/fixture.ts`) requires `PW_SUITE=integration` and hard-codes and verifies the fixture hostname/database; never make it accept a deployment connection string. The shared runner contains PostgreSQL client tooling and copies `src/database/` (including `002_tasks.sql` with `seed_metadata` one-time initialization bookkeeping and `003_task_creation_constraints.sql`), so Docker and Compose remain the only host requirements. Each test in `task-fixture.spec.ts` resets the fixture (`DROP TABLE IF EXISTS tasks, seed_metadata`) to the clean seeded baseline before and after execution and waits for fixture API readiness. No other suite may target this fixture concurrently.

After the integration suite, `bash scripts/test-task-persistence.sh recoverboard-test` creates a uniquely identified task through the real fixture API (`POST /api/tasks`), updates it via `PUT /api/tasks/{id}`, creates and deletes a second task via `DELETE /api/tasks/{id}`, deletes a seeded task (`Audit dependencies`) via `DELETE /api/tasks/{id}`, edits another seeded fixture row, restarts the fixture database, replays the actual migration image, restarts the fixture app, compares full SQL snapshots, and verifies via `GET /api/tasks/{id}` and `GET /api/tasks` that the surviving updated task's fields, ID, and timestamps survived unchanged while both the API-deleted task and deleted seeded task remain permanently absent (`404`). Both CI integration jobs run this check before artifact collection and cleanup; failures block deployment. Run it only against the isolated test project (names must be `recoverboard-test` or start with `recoverboard-test-`). The runner never receives a Docker socket.

Set `-e PW_ARTIFACTS_DIR=/artifacts/local-smoke` on a local smoke runner invocation to retain integration reports at their default locations while writing smoke reports to a separate subdirectory. Always report executed tests, pass/fail counts, unexecuted checks (such as post-deployment smoke against a live remote host), and any coverage gaps accurately.
