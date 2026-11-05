# Slice 5 — Task deletion implementation plan

## Scope and planning status

Planning only: this document does not implement functionality. Add permanent task deletion through `DELETE /api/tasks/{id}` and an explicit confirmation flow reached from the existing task editor. Preserve user selection, creation, editing, quick status changes, board ordering, counts, refresh, and persistence. No recycle bin, soft deletion, undo, authorization redesign, UI redesign, or new test runner.

The supplied prompt ends at “Execute a parameterised DELETE statement.” Requirements below that go beyond the supplied text are proposed implementation decisions, not quoted requirements.

## Repository inspection and baseline

Read root, backend, and frontend `AGENTS.md`; inspected Go routing, handlers, models and tests; task schema/seeding and Slice 3 constraint migration; React board, details/creation dialogs, API helper and application state; testing/debt documentation; Playwright integration/smoke fixtures and configuration; runner Dockerfile; both Compose files; PR/deployment workflows; and the persistence script.

Baseline and items to address during implementation:

1. **Slices 3 and 4 are implemented in this checkout.**
   - `src/tasks.go` and `src/types.go` expose `GET /api/tasks`, `POST /api/tasks`, `GET /api/tasks/{id}`, and `PUT /api/tasks/{id}` through `taskReader` / `sqlTaskReader` (`List`, `Get`, `Create`, `Update`), using `parseTaskPathID` (`positiveDecimalID`, `1..2147483647`) and five-second request-context deadlines (`context.WithTimeout(r.Context(), 5*time.Second)`).
   - `src/web/src/TaskBoard.tsx` owns the `{tasks, rejected}` snapshot, `load({ force?: boolean })`, `invalidateInFlightLoad()`, `replaceTaskById()`, per-card quick status controls (`pendingQuickIdsRef`, `quickErrors`), `CreateTaskDialog.tsx`, and `TaskDetailsDialog.tsx`.
   - `src/web/src/TaskDetailsDialog.tsx` implements the modal `<dialog>` (`showModal()`) editor with `submittingRef` duplicate-submission protection, `fetchTask` detail loading, `taskGone` 404 handling, and `uncertainSave` GET reconciliation (`Check latest task` / `Reload latest task`).
   - `src/web/src/taskApi.ts` provides `fetchTasks`, `fetchTask`, `createTask`, `updateTask`, and `parseErrorResponse`.
2. **Structured JSON errors are established.** Handlers and `taskDatabaseHandler()` return `APIError{Error, Message, Fields}` via `writeError`. `DELETE /api/tasks/{id}` will reuse `parseTaskPathID` (`400 invalid_task_id`), `404 not_found`, and `500 internal_error`.
3. **Seed replay currently reverses deletion.** `src/database/migrations/002_tasks.sql` reinserts any missing `seed_key` on every migration run; `tests/playwright/integration/task-fixture.spec.ts` currently asserts this resurrection behavior. Permanent deletion must survive migration replay and redeployment as well as page reload.
4. **Existing tests assume `DELETE /api/tasks/{id}` returns 405.** `tests/playwright/integration/tasks.spec.ts` expects `DELETE` to return 405 on both `/api/tasks` and `/api/tasks/{id}`. Update only retired detail-route expectations while keeping collection `DELETE /api/tasks` and `PATCH` 405 assertions and keeping shared baseline tests isolated from destructive fixture tests in `tests/playwright/integration/task-fixture.spec.ts`.
5. **The working tree is clean on `main`.** Preserve existing Slice 3 and Slice 4 behavior and test coverage while adding Slice 5 task deletion.

### Intended implementation

Extend `taskReader` / `sqlTaskReader` with an atomic parameterized `Delete`, reuse `parseTaskPathID` and `writeError`, gate demo seeding with durable initialization metadata in `002_tasks.sql`, add a destructive **Delete task** action and accessible confirmation flow to `TaskDetailsDialog.tsx`, and remove the task from `TaskBoard.tsx` state only after confirmed `204 No Content`. Coordinate refresh and mutation requests via `invalidateInFlightLoad()` and `load({ force: true })` so older responses cannot restore deleted cards. Test writes only against isolated real services; deployed smoke exercises confirmation and cancellation under the fail-closed mutation guard without sending mutations.

## 1. Backend endpoint

Files to update: `src/tasks.go`, `src/tasks_test.go`, and `src/tasks_contract_test.go`. Existing `/api/tasks` and `/api/tasks/` registrations in `src/main.go` already delegate to `taskDatabaseHandler()` and `taskHandlers`.

- Register `DELETE /api/tasks/{id}` on `taskHandlers`; no request body or `Content-Type` header is required for success.
- Reuse `parseTaskPathID(r.PathValue("id"))` to reject nonnumeric, signed, zero, negative, fractional, and overflowing IDs with `400 invalid_task_id` (`"invalid task id"`) before database work, preserving the exact ID validation policy used by `GET /api/tasks/{id}` and `PUT /api/tasks/{id}`.
- Extend `taskReader` (and `sqlTaskReader`, `fakeTaskReader`, `contextTaskReader`) with `Delete(ctx context.Context, id int) (bool, error)`.
- Execute `DELETE FROM tasks WHERE id = $1` with `ExecContext` and inspect `RowsAffected()`. A single statement is atomic; do not perform a separate existence query that introduces a race.
- Map one affected row (`true, nil`) to `204 No Content` (`w.WriteHeader(http.StatusNoContent)` with zero response bytes), zero affected rows (`false, nil`) to `writeError(w, http.StatusNotFound, "not_found", "task not found", nil)`, and execution/affected-row errors to `log.Printf("delete task: %v", err)` plus `writeError(w, http.StatusInternalServerError, "internal_error", "unable to delete task", nil)`.
- Retain request cancellation and the five-second database timeout (`context.WithTimeout(r.Context(), 5*time.Second)`). Log unexpected errors server-side without connection strings or private SQL details in responses.
- A repeated delete returns 404; concurrent deletes produce one 204 and one 404. Do not treat arbitrary failures as success.
- Leave users and unrelated tasks untouched. Foreign keys in `002_tasks.sql` point from `tasks` to `users`, and `003_task_creation_constraints.sql` adds only check constraints on `tasks`, so deleting a task requires no cascade or table redesign.
- User selection remains a local preference, not authentication. Do not invent creator-only permissions or trust `localStorage` as authorization.

## 2. Preserve permanent deletion across seed replay

No task-column change is needed for hard deletion. The replayable seed mechanism in `src/database/migrations/002_tasks.sql` does need adjustment.

- Establish one-time demo-task seeding using durable initialization metadata (`seed_metadata` table with primary key `seed_key` and `seeded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP`), not per-task tombstones or a soft-delete flag.
- Gate the seed `INSERT` inside `src/database/migrations/002_tasks.sql` itself; adding a later migration alone is insufficient because `src/Dockerfile.migrations` and `tests/playwright/helpers/fixture.ts` replay `002_tasks.sql` on every run before `003_task_creation_constraints.sql`.
- Before `CREATE TABLE IF NOT EXISTS tasks`, check `to_regclass('public.tasks') IS NOT NULL` inside a transactional `DO $$ ... END $$;` block:
  - **Existing database upgrade (`tasks` already existed before `002_tasks.sql` ran):** record `'recoverboard:slice2:tasks'` in `seed_metadata` (`ON CONFLICT DO NOTHING`) without running the seed `INSERT`. This handles both populated and legitimately empty existing `tasks` tables without inferring "never initialized" from a zero row count.
  - **Fresh database (`tasks` did not exist and `seed_metadata` lacks `'recoverboard:slice2:tasks'`):** create `tasks`, insert the 10 initial seed rows (`ON CONFLICT (seed_key) DO NOTHING`), and record `'recoverboard:slice2:tasks'` in `seed_metadata` atomically.
  - **Subsequent migration replays:** `seed_metadata` already contains `'recoverboard:slice2:tasks'`, so deleted demo tasks are never reinserted.
- Retain migration transactionality, advisory locking, timeouts, and compatibility with production's app-before-migration rollout (`seed_metadata` is strictly migration-internal and unused by the Go server at runtime).
- Replace the old seed-resurrection assertion in `tests/playwright/integration/task-fixture.spec.ts` with tests for fresh initialization, populated and empty Slice 2/3/4 upgrades, repeatability, preservation of unrelated rows, deletion of one and all seed tasks, and restart/migration replay without resurrection.
- Update `resetFixture()` in `tests/playwright/helpers/fixture.ts` to `DROP TABLE IF EXISTS tasks, seed_metadata;` so fresh-install fixture resets clear initialization metadata deliberately while `migrate()` replay calls retain it. Never reset development or deployment data.

## 3. Frontend confirmation and lifecycle

Files to update: `src/web/src/TaskDetailsDialog.tsx`, `src/web/src/TaskBoard.tsx`, `src/web/src/taskApi.ts`, and `src/web/src/App.css`.

1. Add a clearly labelled **Delete task** button (`type="button"`, `.danger-button` / `.delete-trigger-button`) to `TaskDetailsDialog.tsx`, visually distinct from **Save Changes** and **Cancel**. Deletion targets the persisted `taskId` and must not submit or save unsaved form edits.
2. Activating **Delete task** transitions the modal into an explicit confirmation view (within the active `<dialog>` to avoid competing modal focus traps) displaying the persisted task title and warning: “Permanently delete this task? This cannot be undone.” Offer **Cancel** and **Delete task**; opening confirmation does not issue `DELETE`.
3. Provide accessible labelling (`aria-labelledby` / `aria-describedby`), focus containment inside the `<dialog>`, initial focus on **Cancel** when confirmation opens, Escape cancellation while idle (returning from confirmation to the editor with unsaved fields intact and restoring focus to the editor's **Delete task** button), and preserved unsaved draft fields when cancelling confirmation.
4. Add a typed `deleteTask(id: number)` helper in `src/web/src/taskApi.ts` using same-origin `fetch('/api/tasks/' + id, { method: 'DELETE' })`. Expect `204` (`{ kind: 'deleted' }`) and do not parse JSON on 204. Map `404` to `{ kind: 'not_found', message }`, other non-2xx responses via `parseErrorResponse` to `{ kind: 'rejected', status, message }`, and transport errors or unexpected statuses to `{ kind: 'uncertain', message }`.
5. On confirmation, take the synchronous `submittingRef` in-flight guard and disable duplicate submission, conflicting Save/Cancel actions, and Escape dismissal until the request settles. Show “Deleting…” on the confirm button. Never auto-retry `DELETE`.
6. On confirmed `204`, close `TaskDetailsDialog`, discard that task's unsaved draft, call `invalidateInFlightLoad()`, remove `taskId` from `snapshot` using a functional state update (preserving task ordering and `rejected` count), clear any `quickErrors[taskId]`, announce `"Task deleted."` via `notice`, move focus to an adjacent task card trigger or stable board control (`Create Task` / `Refresh`), and trigger a background reconciliation `load({ force: true })`.
7. Coordinate deletion with outstanding list/detail/quick-status requests. Prevent deleting or opening details while a quick-status mutation is in flight for that task, abort/invalidate older list `GET` requests (`invalidateInFlightLoad()`), and ensure stale responses cannot reinsert a deleted card. Retain StrictMode and unmount safety.
8. If background reconciliation `load({ force: true })` fails after confirmed deletion, keep the deleted task removed from the local board snapshot and display a distinct alert (`"Task deleted, but the board could not be refreshed."`) with a GET-only **Retry refresh** button. Do not report deletion failure or reinsert the task.
9. On definite `500` (`kind: 'rejected'`), keep the confirmation/editor open, preserve the card and draft, and display the error alert so the user can retry **Delete task** or **Cancel** back to the editor. On `404` (`kind: 'not_found'`), explain that the task no longer exists on the server, remove/reconcile the stale board card, and close or offer board refresh without claiming this request deleted it.
10. On transport failure (`kind: 'uncertain'`), do not claim the task remains saved or blindly retry `DELETE`. Offer a read-only **Check latest task** action (`fetchTask(taskId)` + `onRefreshBoard()`): if `fetchTask` returns `404 not_found`, confirm the task was already removed and reconcile/close without issuing another `DELETE`; if `fetchTask` returns `200 ok`, inform the user the task still exists on the server and allow deliberate retry or cancellation.

## 4. Automated coverage

### Go unit tests

Extend `fakeTaskReader` and `contextTaskReader` in `src/tasks_test.go` and `src/tasks_contract_test.go` without adding a mocking framework:

- Successful `DELETE /api/tasks/{id}`, store receives the ID, `204 No Content`, and zero response bytes.
- Missing/repeated deletion (`false, nil`) maps to JSON `404` (`not_found`).
- Invalid ID table (`abc`, `+1`, `-1`, `0`, `1.0`, `1e1`, `2147483648`, `999999999999999999999`); no store `Delete` invocation.
- Store failures, cancellation/deadline errors, and generic JSON `500` (`internal_error`) without leaked diagnostics.
- Request context/deadline propagation and supported/unsupported route-method behavior (`DELETE /api/tasks` remains `405`).
- SQL result/error mapping backed by real-stack tests below rather than unit fakes alone.

### Real-stack Playwright integration

Use the existing common image/config/package and real React, Go, and PostgreSQL. Do not mock these components for deletion acceptance coverage.

- Consolidate destructive tests into the existing serial `tests/playwright/integration/task-fixture.spec.ts` suite, which exclusively owns `fixture-app`/`fixture-database`. Independent specs with `mode: serial` do not serialize against each other.
- Use per-test setup/cleanup (`resetFixture()`), unique tasks and IDs created via `POST /api/tasks`, and the guarded `sql()` helper for controlled database conditions. Keep ordinary `app` baseline tests untouched by writes; reset safely on retries/failures.
- Main journey: create task, open `Task Details` dialog, review title/warning in the delete confirmation step, confirm, assert one real `DELETE /api/tasks/{id}` and empty `204`, closed dialog, absent card, correct column decrement, unchanged other columns/tasks, unchanged selected user, reload, list omission, and detail `404`. Check the PostgreSQL row is absent.
- Cover deletion from each status (`todo`, `in_progress`, `done`) and deletion of the last task in a column and on the board, including empty-state messages (`No tasks in this column.`, `No tasks yet`).
- Cancel and Escape: no `DELETE` request, card/counts and stored row unchanged, unsaved editor fields preserved when returning from confirmation, and focus restored to the editor's **Delete task** button. Include keyboard navigation and narrow-screen (`320x700`) layout coverage.
- Repeated confirmation: no duplicate mutation. Exercise pending state (`Deleting…`) and disabled controls against the real fixture.
- Already-deleted task: a second real API request (`DELETE` or SQL removal) removes the task while its editor/confirmation is open; confirming produces `404` and reconciles stale UI without claiming this request deleted it.
- Error/recovery: exercise `500` failure on `DELETE` (preserving card/editor and allowing deliberate retry), transport-loss uncertain outcome with read-only `Check latest task` reconciliation, and stale in-flight `GET /api/tasks` protection plus failed post-delete board refresh (`Task deleted, but the board could not be refreshed` with GET-only `Retry refresh`).
- API contract: no-body `DELETE`, invalid IDs (`400`), nonexistent ID (`404`), repeated/concurrent deletes (exact one `204` and `404` for the rest), list/detail absence, untouched user and unrelated task records. Update `tests/playwright/integration/tasks.spec.ts` so collection `DELETE /api/tasks` and `PATCH` still assert `405` while detail `DELETE /api/tasks/{id}` is validated with invalid (`400`) and nonexistent (`404`) IDs without mutating the shared `app` seed tasks.
- Persistence: verify ordinary and seeded deletions survive page reload, app/database restart, and migration replay. Extend `scripts/test-task-persistence.sh` within its existing isolated-project guard to verify that a task created and deleted via `DELETE /api/tasks/{id}` and a deleted seeded task both remain absent across database restart, `fixture-migrator` replay, and app restart.
- Preserve creation, editing, reassignment, priorities, quick status, user persistence, and manual refresh regression coverage from Slices 2–4.

Supplemental transport-loss tests may use browser network controls, but must be labelled as narrow resilience coverage and cannot replace real-stack acceptance tests.

### Non-destructive smoke

Extend `tests/playwright/smoke/tasks.spec.ts` using the same runner. When a deployed task exists, open its `Task Details` dialog, open the **Delete task** confirmation view, check its task title and irreversible-action warning (`Permanently delete this task? This cannot be undone.`), then cancel (via **Cancel** and `Escape`) and verify the editor and card remain unchanged. Observe requests under the existing fail-closed mutation guard that aborts and fails on any attempted `POST`/`PUT`/`PATCH`/`DELETE`. Never confirm deletion, create temporary deployed tasks, access SQL, or use infrastructure credentials.

An empty deployed board remains valid: assert its empty state and report if the task-dependent cancellation path was not exercised.

## 5. Documentation and CI

- Update `AGENTS.md`, `src/AGENTS.md`, and `src/web/AGENTS.md` to reflect implemented `DELETE /api/tasks/{id}`, the delete confirmation workflow, and one-time seed initialization metadata while retaining all mandatory test policies.
- Update `docs/TESTING.md` with deletion cases, fixture ownership, non-destructive smoke boundaries, `seed_metadata` initialization semantics, and persistence verification.
- Keep one `Dockerfile.playwright`, Compose overlay, package, and lockfile. No host browser execution.
- Preserve both GitHub Actions gates, report uploads, cleanup, serialized production deployment, and smoke-after-migrations sequencing.
- No OpenTofu resource changes are required.

## 6. Execution and completion gates

Implement backend and seeding safety, UI confirmation/lifecycle, tests, and documentation in reviewable increments.

Run Go formatting (`gofmt`), `go test ./...`, `go vet ./...`, and `go build -o /tmp/cca-demo .` from `src`. Run `pnpm install --frozen-lockfile`, `pnpm lint`, and `pnpm build` from `src/web` (no frontend unit-test script exists in `src/web/package.json`; do not claim one ran).

Run the full integration suite from repository root using the documented isolated Compose workflow:

```sh
status=0
docker compose -p recoverboard-test -f src/docker-compose.yaml -f compose.test.yaml --profile integration up --build -d app || status=$?
if [ "$status" -eq 0 ]; then
  docker compose -p recoverboard-test -f src/docker-compose.yaml -f compose.test.yaml --profile integration run --build --no-deps --rm playwright npm run test:integration || status=$?
fi
if [ "$status" -eq 0 ]; then
  bash scripts/test-task-persistence.sh recoverboard-test || status=$?
fi
# Run local-app smoke here before cleanup where practical; retain its exit status.
docker compose -p recoverboard-test -f src/docker-compose.yaml -f compose.test.yaml --profile integration logs > integration-compose.log || true
docker compose -p recoverboard-test -f src/docker-compose.yaml -f compose.test.yaml --profile integration down -v --remove-orphans || { cleanup_status=$?; [ "$status" -ne 0 ] || status=$cleanup_status; }
exit "$status"
```

Before teardown, local smoke uses the same isolated project/network and service with `PW_SUITE=smoke`, `BASE_URL=http://app:8080`, and `PW_ARTIFACTS_DIR=/artifacts/local-smoke`. Capture failures without overwriting prior failures. Never clean ordinary development volumes.

Post-deployment smoke remains:

```sh
BASE_URL=https://your-host.example docker compose -p recoverboard-smoke -f src/docker-compose.yaml -f compose.test.yaml run --build --no-deps --rm -e PW_SUITE=smoke -e BASE_URL playwright npm run test:smoke
```

Retain HTML, JUnit and traces under `artifacts/playwright/`. Completion requires passing required checks, unchanged prerequisite functionality, safe confirmation/cancellation, correct API statuses, permanent absence through replay, correct board/count updates, and no destructive deployed tests. Report changed files, tests added/modified/executed, exact pass/fail results, unrun checks and remaining coverage gaps.

**Planning verification:** repository inspection only; no application code changed and no tests executed for this plan.
