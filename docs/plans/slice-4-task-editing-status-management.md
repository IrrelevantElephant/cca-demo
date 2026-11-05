# Slice 4 — Task editing and status management

## Status and scope

**Status:** Implemented and verified. Full task editing and all six status transitions (`PUT /api/tasks/{id}`, `TaskDetailsDialog.tsx`, and card quick status controls) are complete while preserving task creation, user selection, listing, refresh and persistence. Deletion, filtering, dashboard summaries, drag-and-drop, permissions, authentication, audit history, real-time updates, infrastructure changes and Slice 5 remain out of scope.

## 1. Inspected baseline and prerequisite gate

Read root, Go and frontend `AGENTS.md`, scoped technical-debt/testing documentation, Go handlers/models/tests, task migrations, React board/dialog/API/types/user state, Playwright helpers/suites/configuration, Dockerfiles/Compose, persistence script and both GitHub Actions workflows.

**The current checkout includes the completed Slice 3 (task creation) baseline.**

- `src/tasks.go` and `src/types.go` expose `GET /api/tasks`, `POST /api/tasks` and `GET /api/tasks/{id}` through `taskReader` / `sqlTaskReader` (`List`, `Get`, `Create`). Handlers use five-second request-context deadlines (`context.WithTimeout(r.Context(), 5*time.Second)`) and return structured JSON errors (`APIError{Error, Message, Fields}`) via `writeError`. `POST /api/tasks` enforces `Content-Type: application/json` (`415 unsupported_media_type`), bounds bodies with `http.MaxBytesReader` at `maxTaskBodyBytes = 64 * 1024` (`413 request_too_large`), rejects malformed/trailing/non-object JSON (`400 invalid_json`), validates allowed keys and field rules (`maxTitleRunes = 200` pre-trim, non-empty trimmed title, optional string `description` up to `maxDescRunes = 2000` with preserved whitespace, `priority`, and positive PostgreSQL integer IDs via `parsePositivePostgresID`), and maps `pq.Error` `23503`/`23514` constraint violations to `400 validation_failed` field errors via `mapCreateTaskError` (including `assigned_to: "Assigned user does not exist."`).
- `src/web/src/TaskBoard.tsx` owns a `{tasks, rejected}` snapshot, refresh/error/notice state, `postCreateRefreshFailed` recovery, `CreateTaskDialog` session state and an abort controller (`load({ force?: boolean })`). Cards (`TaskCard`) remain read-only (`<li className="task-card" data-task-id={task.id}>`); there is no `TaskDetailsDialog.tsx` or quick status control yet.
- `src/web/src/CreateTaskDialog.tsx` establishes the modal `<dialog>` (`showModal()`) pattern, `submittingRef` duplicate-submission guard, `codePointLength` character counters, `aria-invalid`/`aria-describedby` field errors, `focusFirstInvalid` focus management and uncertain-save recovery (`Check board` via `onCheckBoard`).
- `src/web/src/taskApi.ts` exports `maxTitleCodePoints = 200`, `maxDescriptionCodePoints = 2000`, `codePointLength`, `fetchTasks` and `createTask` (`CreateTaskResult`: `created | rejected | uncertain`), and validates task payloads via `invalidReason`, `postgresID` and `timestamp`. There are no `fetchTask` or `updateTask` helpers yet. `types.ts` defines `Task` (with `description: string | null`) and `CreateTaskPayload`. User identity remains in `App.tsx`/`UserContext`, persisted under `recoverboard.selectedUserId`.
- `002_tasks.sql` provides all nine public task fields, enum/FK/non-empty-title constraints, `seed_key` seeding and timestamp defaults. `003_task_creation_constraints.sql` adds `tasks_title_max_length_check` (`char_length(title) <= 200`) and `tasks_description_max_length_check` (`description IS NULL OR char_length(description) <= 2000`) as `NOT VALID` constraints enforced by PostgreSQL on all new `INSERT` and `UPDATE` writes. There is no automatic `updated_at` trigger; updates must assign `updated_at = CURRENT_TIMESTAMP` explicitly.
- `tests/playwright/integration/tasks.spec.ts` asserts `POST /api/tasks` with `{}` returns `400`, while `POST /api/tasks/{id}` and `PUT`/`PATCH`/`DELETE` on `/api/tasks` and `/api/tasks/{id}` return `405`, and the primary `app` database retains its exact 10 seed tasks. `tests/playwright/smoke/task-creation.spec.ts` covers non-destructive creation dialog defaults and validation under a fail-closed non-GET route guard.
- A separate guarded SQL fixture (`fixture-app`, `fixture-migrator`, `fixture-database`) exists in `compose.test.yaml`. Only the serial `tests/playwright/integration/task-fixture.spec.ts` targets it, resetting via `resetFixture()` and `waitForFixture(request)` before and after each test. `scripts/test-task-persistence.sh` verifies both API-created tasks (`POST /api/tasks`) and SQL-updated seed rows across fixture database restart, migration replay and app restart.

**Prerequisite status:** The Slice 3 baseline is present and reconciled above. Reuse its `APIError` envelope (`{ "error", "message", "fields" }`), `Content-Type` (`415`) and body-size (`413`) checks, `parsePositivePostgresID` helper, `pq.Error` constraint mapping, `<dialog>` modal/focus conventions, `codePointLength` validation and serial `task-fixture.spec.ts` isolation.

## 2. API contract and backend implementation

### Contract decisions

- Add only `PUT /api/tasks/{id}`; no PATCH or separate status endpoint. Require `Content-Type: application/json` (allowing parameters via `mime.ParseMediaType`, returning `415 unsupported_media_type` otherwise) and bound request bodies to `maxTaskBodyBytes` (`64 * 1024`, returning `413 request_too_large`), matching `POST /api/tasks`.
- Required editable properties: `title`, `priority`, `assigned_to`, `status`. Optional `description` must be a string when supplied. PUT semantics matching Slice 3 decoding: omitting `description` sets `Description` to `nil` (clearing the column to SQL `NULL`), supplying `"description": ""` stores an empty string, and the UI normalizes `null` to `""` in form state (either sending the string or omitting empty string consistently; document the chosen behavior). Reject explicit `null` or non-string `description` input with `400 validation_failed`.
- Title must contain non-whitespace text and be at most 200 Unicode code points (`maxTitleRunes = 200` checked before `strings.TrimSpace`, matching `decodeAndValidateCreateTask`); description at most 2,000 Unicode code points (`maxDescRunes = 2000` with whitespace preserved). Align frontend length validation (`codePointLength`) with backend rune counting.
- Require supported enum values (`priority` in `low`, `medium`, `high`; `status` in `todo`, `in_progress`, `done`) and a positive PostgreSQL integer `assigned_to` ID (`1..2147483647` via `parsePositivePostgresID`) referring to an existing user. Reject missing/null required values, wrong types and fractional/exponent/out-of-range IDs.
- Reject all unknown properties in `fields` with `"Field is not allowed when updating a task."`, including any appearance of `id`, `created_by`, `created_at`, `updated_at` or internal `seed_key`, even when equal to existing values.
- Return `200 OK` with the complete nine-field task; `400` (`invalid_task_id`, `invalid_json` or `validation_failed`) for invalid path/body/fields or nonexistent assignee (`fields.assigned_to: "Assigned user does not exist."`), `404` (`not_found`) for an absent task, and generic `500` (`internal_error`) for unexpected persistence errors.
- Reuse Slice 3's `writeError` helper and `APIError` (`{ "error", "message", "fields" }`) envelope across all task endpoints.

### Implementation steps

1. Extend `taskReader` / `sqlTaskReader` in `src/tasks.go` (and `fakeTaskReader` in `src/tasks_test.go` plus `contextTaskReader` in `src/tasks_contract_test.go`) with `Update(context.Context, int, UpdateTaskInput) (Task, error)`; use a dedicated `UpdateTaskInput` struct in `src/types.go`, never decoding the request into the public `Task` model. Keep SQL in the existing storage layer and avoid introducing a repository framework.
2. Reuse/extract the strict positive decimal task-ID path validation (`positiveDecimalID` and `1..2147483647`) shared with `GET /api/tasks/{id}`.
3. Decode a bounded body (`maxTaskBodyBytes`) with unknown-field rejection, required-field/type checks, and an EOF check to reject trailing JSON (sharing or mirroring `decodeAndValidateCreateTask`). Require one JSON object; reject empty, malformed, array and null bodies.
4. Use the request context with the existing five-second timeout for writes. Ensure an absent task ID returns `404 not_found` while a valid task ID with a nonexistent `assigned_to` user returns `400 validation_failed` (`fields.assigned_to: "Assigned user does not exist."`), extending `mapCreateTaskError` (e.g. `mapTaskWriteError`) to handle `pq.Error` `23503` (`tasks_assigned_to_fkey`) and `23514` (`tasks_*_check`, including status).
5. Execute one parameterized `UPDATE tasks SET title=$1, description=$2, priority=$3, assigned_to=$4, status=$5, updated_at=CURRENT_TIMESTAMP WHERE id=$6 RETURNING ` + `taskColumns`. Preserve ID, creator, creation time and seed identity by never assigning them. Normalize returned timestamps to UTC as `Get` and `Create` do.
6. Map `sql.ErrNoRows` to `404` (`not_found`, `"task not found"`) for a valid update request. Log safe diagnostics server-side; never send SQL/internal errors or credentials to clients. Validation failures must leave the entire row, including timestamps, unchanged.
7. Document last-write-wins: any user may overwrite editable state; full-state quick updates can overwrite changes made by another client since loading. No version columns, optimistic locking, authentication checks or workflow restrictions. All six directed status transitions are valid. A successful identical PUT may also advance `updated_at`.

### Database strategy

No new migration is needed: `002_tasks.sql` and `003_task_creation_constraints.sql` already provide all columns, enum/FK checks, and `NOT VALID` title/description length constraints enforced on `INSERT` and `UPDATE`. Set `updated_at = CURRENT_TIMESTAMP` explicitly in the `UPDATE` query because column defaults only apply to `INSERT`. Retain all current database constraints and never edit already-applied migrations or truncate development data.

## 3. Frontend implementation

### API and board state

- Add an explicit `TaskUpdateInput` (or `UpdateTaskPayload`) type in `src/web/src/types.ts` and `fetchTask`/`updateTask` helpers in `src/web/src/taskApi.ts`. Serialize only editable fields, never spread the full task into a PUT request. Validate successful detail/update responses with shared `invalidReason` task-shape validation, including verifying that `task.id` matches the requested ID, and reuse `createTask`'s structured `{ message, fields }` error-parsing pattern.
- Keep authoritative tasks in `TaskBoard`; use one functional replace-by-ID callback on `snapshot` for both dialog and quick updates. Derive columns/counts from that state and preserve created-time/ID ordering. Keep existing rejected-record diagnostics, post-create refresh behavior and stale-refresh handling.
- Maintain a separate local dialog draft so Cancel and failed requests never alter board state. Active-user switching must neither clear the shared board nor change `created_by`.
- Prevent a stale GET from overwriting a successful PUT. Extend `TaskBoard`'s `pending` abort/request-generation guard and disable Refresh while a mutation is pending; abort/invalidate any already-running refresh before accepting a mutation. Prevent overlapping writes for the same task, and do not allow a quick update while that task is being edited. Avoid new global state dependencies.

### Details/edit dialog

- Add `TaskDetailsDialog.tsx` following `CreateTaskDialog.tsx`'s `<dialog>` (`showModal()`, `onCancel`, `Escape` handling, `submittingRef` guard, `codePointLength` counters, `aria-invalid`/`aria-describedby` field errors and `focusFirstInvalid`) and plain-CSS patterns in `App.css`. Extract only genuinely shared small form/validation pieces; no generic form framework.
- Make the card body an accessible open-details target with a real keyboard-operable button. Keep the quick select a sibling, not an interactive descendant of a button; pointer activation of the card body must also open details.
- On open, load the latest task using `fetchTask` (`GET /api/tasks/{id}`), show loading/retry feedback and handle 404 explicitly. Only populate an editable draft from a valid response; do not overwrite an existing draft with background refreshes.
- Show title, full description, status, priority and assignee controls, plus read-only creator, creation date and update date. Resolve names from the users array; use `Unknown user` for missing references and require a valid assignee before saving.
- Add labels, required/length/enum validation (`maxTitleCodePoints = 200`, `maxDescriptionCodePoints = 2000`), accessible error messages and a clear Save Changes/Cancel pair. Trap focus using native modal `<dialog>` semantics, focus a useful initial control, support Escape when idle, and restore focus to the card trigger (or a sensible board fallback after movement/removal).
- During save, prevent duplicate submissions and accidental Escape/backdrop/Cancel closure. Await a validated server response before replacing the task and closing. On validation, unavailable API or malformed-response failure, preserve the draft and dialog and leave the board unchanged.
- On 404 after opening, explain that the task is no longer available; preserve the draft for inspection and offer closing/refreshing rather than creating a replacement.
- On transport interruption, explain the save may have succeeded; do not automatically repeat PUT. Offer a read/reconciliation action that preserves the draft until the user chooses to reload or explicitly save again.

### Quick status control

- Render a compact labelled native select with all three statuses on each card. Stop card activation from control interactions and support keyboard selection.
- Build a complete editable payload from the current authoritative task plus the requested status. Preserve title, priority, assignee and description value according to the agreed nullable-description contract.
- Keep the displayed status/column unchanged until PUT succeeds; disable repeat interaction while pending and expose pending/error feedback associated with the task.
- On success, replace the task using the response, update counts, move it to the target column and manage focus after movement. On failure, retain the old card/column and allow explicit retry, with the same uncertain-outcome warning for network failures.

## 4. Automated coverage

### Isolation and regression strategy

Preserve Slice 3's isolation architecture: keep the main integration `app` read-only so fixed seed assertions (`tasks.spec.ts`) and parallel selection/list tests remain meaningful. Register new mutation tests within the existing serial fixture owner (`tests/playwright/integration/task-fixture.spec.ts`, optionally via imported registration helpers), not an independently scheduled spec using the same `fixture-app`/`fixture-database`. Each test resets to the clean seeded baseline via `resetFixture()` and `waitForFixture(request)`, prepares its own identifiable records and obtains IDs from POST/SQL `RETURNING`; use the guarded fixture SQL helper (`helpers/fixture.ts`) for cleanup and disappeared-task setup only. Setup must not depend on a previous test's mutations; cleanup runs in `beforeEach`/`afterEach`/`afterAll`. Restore schema/seed expectations before `scripts/test-task-persistence.sh`. Do not introduce a production deletion route.

In `tests/playwright/integration/tasks.spec.ts`, update the method-restriction check only for `PUT /api/tasks/{id}` (sending an invalid body `{}` and asserting `400` with `application/json`, matching the existing `POST /api/tasks` check while leaving the main `app` database untouched). Keep `POST /api/tasks/{id}`, `PUT /api/tasks`, and `PATCH`/`DELETE` on both `/api/tasks` and `/api/tasks/{id}` returning `405`. Preserve existing seed, sorting (`helpers/api.ts` sub-millisecond `timeKey`), malformed-data, cancellation, refresh, empty-board, mobile and keyboard assertions.

### Go tests

Extend `src/tasks_test.go` and `src/tasks_contract_test.go` with table-driven handler/input tests for valid PUT, every invalid-ID case, `415` unsupported media type, `413` oversized body, required/missing/null/wrong-type properties, whitespace and Unicode boundaries, all status and priority enum values, assignee failures (`23503`), check-constraint mapping (`23514`), immutable/unknown fields, malformed/trailing JSON, missing task (`404`) and generic database errors (`500`). Verify invalid requests never invoke a write, context deadlines/cancellation propagate through `contextTaskReader`, and complete returned tasks preserve immutable data. Test constraint-error translation without exposing internals. Real SQL behavior remains covered by Playwright against PostgreSQL.

### Playwright integration matrix

1. **Edit details:** prepare/create a unique task, open it, change title/description/priority, save, verify card plus GET detail/list and direct fixture SQL values.
2. **Reassign:** Alice to Bob, save, verify resolved card name and persistence after page reload.
3. **Dialog status:** To Do to In Progress, assert source/destination counts and persistence after manual and browser refresh.
4. **Quick status:** use card control with pointer and keyboard, assert no dialog opens, server-confirmed movement/counts and SQL persistence.
5. **Transitions:** exercise all six directed transitions via real PUT; include unchanged status and full response contracts.
6. **Immutable fields:** individually submit ID, creator and both timestamps (including unchanged values); expect rejection and exact before/after row equality. Successful edits preserve creator/creation time and advance update time.
7. **Validation:** empty/whitespace/overlong title, overlong description, length boundaries including Unicode, missing required fields, invalid/null/type-mismatched values, nonexistent assignee, malformed/trailing JSON, unsupported content type, oversized body and unknown properties. Rejected updates leave rows intact.
8. **Missing task:** valid absent ID gives 404; malformed IDs give 400. Delete only a fixture record via guarded SQL after load/open and verify real frontend GET/PUT 404 handling.
9. **Resilience:** narrowly intercept PUT in the designated resilience coverage to test 400/500/transport failures, pending duplicate prevention, draft retention, no false board updates and explicit retry. Include quick-control failure and a response-lost-after-write case with GET reconciliation. Core success/validation/persistence tests never mock app/API/database.
10. **Regression/accessibility:** creation (`CreateTaskDialog`) remains working; Alice creates, Bob edits/reassigns to Charlie, creator stays Alice. Verify active-user persistence/switching, listing, accurate counts, manual refresh, Cancel/Escape without writes, focus management, mobile layout, stale refresh versus save ordering and `scripts/test-task-persistence.sh` restart persistence.

### Non-destructive smoke

Extend `tests/playwright/smoke/tasks.spec.ts` (and/or `tests/playwright/smoke/task-creation.spec.ts`) using captured live GET responses. If tasks exist, open one, verify complete details, populated fields, users/priorities/status options and read-only metadata. Inspect quick-control availability without changing it. Cancel and test Escape/focus restoration without saving valid data.

Clear title, attempt invalid submission and assert visible validation and zero mutation requests. Reuse the fail-closed non-GET mutation guard (`page.route('**/api/tasks*', ...)`) that records/aborts any POST/PUT/PATCH/DELETE attempt before it reaches deployment, as a safety net rather than an API mock for successful behavior. Cancel discards browser-local edits. If no tasks exist, assert the board/empty columns instead of skipping/failing the suite or creating data. Preserve application/users/selection/task retrieval/refresh and `smoke/task-creation.spec.ts` coverage.

## 5. Files expected to change

- `src/tasks.go`, `src/types.go`, `src/tasks_test.go`, `src/tasks_contract_test.go`: add `UpdateTaskInput`, `Update` store/handler/validation, error mapping and unit/contract test coverage; routing remains under `taskHandlers`.
- `src/web/src/types.ts`, `src/web/src/taskApi.ts`, `src/web/src/TaskBoard.tsx`, `src/web/src/App.css`; new `src/web/src/TaskDetailsDialog.tsx` and only minimal shared pieces justified alongside `CreateTaskDialog.tsx`.
- `tests/playwright/integration/task-fixture.spec.ts` (and any imported mutation-test helpers) plus `tests/playwright/integration/tasks.spec.ts` (`PUT /api/tasks/{id}` method check) and narrowly scoped resilience coverage.
- `tests/playwright/helpers/api.ts` / `tests/playwright/helpers/board.ts` as needed without weakening contracts; `tests/playwright/smoke/tasks.spec.ts` (and/or `task-creation.spec.ts`) for non-destructive editing smoke coverage; optionally `scripts/test-task-persistence.sh` to verify API-updated task persistence across restart and migration replay.
- `docs/TESTING.md` and scoped `AGENTS.md` files (`AGENTS.md`, `src/AGENTS.md`, `src/web/AGENTS.md`) to reflect implemented `PUT /api/tasks/{id}`, details/editing dialog, quick status transitions and updated test coverage while preserving all mandatory testing/gating policies.
- No expected deployment, Compose, runner/package-lock or SQL migration changes. Reuse the common image/config and automatic test discovery. If implementation changes test dependencies, update the existing image rather than introducing a runner.

## 6. Execution and verification

Implement in reviewable stages: backend contract/tests, API client and details/edit dialog, quick status controls and state-race handling, real-stack integration and smoke coverage, then full regression verification.

Run Go checks from `src`: `gofmt` on changed files, `go test ./...`, `go vet ./...`, `go build -o /tmp/cca-demo .`. Run frontend frozen-lockfile install, `pnpm lint` and `pnpm build` from `src/web`. Currently no frontend unit-test script exists; do not claim one ran. Docker build covers production compilation; all Playwright execution remains container-only.

From repository root, use the established sequence with cleanup on failure/interruption and preserve the initial failure status:

```sh
status=0
docker compose -p recoverboard-test -f src/docker-compose.yaml -f compose.test.yaml --profile integration up --build -d app || status=$?
if [ "$status" -eq 0 ]; then
  docker compose -p recoverboard-test -f src/docker-compose.yaml -f compose.test.yaml --profile integration run --build --no-deps --rm playwright npm run test:integration || status=$?
fi
if [ "$status" -eq 0 ]; then
  bash scripts/test-task-persistence.sh recoverboard-test || status=$?
fi
# Run local smoke before teardown, keeping its reports separate.
if [ "$status" -eq 0 ]; then
  docker compose -p recoverboard-test -f src/docker-compose.yaml -f compose.test.yaml run --build --no-deps --rm -e PW_SUITE=smoke -e BASE_URL=http://app:8080 -e PW_ARTIFACTS_DIR=/artifacts/local-smoke playwright npm run test:smoke || status=$?
fi
docker compose -p recoverboard-test -f src/docker-compose.yaml -f compose.test.yaml --profile integration logs > integration-compose.log || true
docker compose -p recoverboard-test -f src/docker-compose.yaml -f compose.test.yaml --profile integration down -v --remove-orphans || { cleanup_status=$?; [ "$status" -ne 0 ] || status=$cleanup_status; }
exit "$status"
```

Use a shell trap/CI always-cleanup step as well for interrupted execution. The local-smoke invocation uses the existing integration network because the test overlay removes host ports; verify it during implementation. Never apply `down -v` to ordinary development.

Deployed smoke remains the established command:

```sh
BASE_URL=https://your-host.example docker compose -p recoverboard-smoke -f src/docker-compose.yaml -f compose.test.yaml run --build --no-deps --rm -e PW_SUITE=smoke -e BASE_URL playwright npm run test:smoke
```

Preserve `.github/workflows/playwright-pr.yaml` and `pipeline.yaml` integration gates, migration/deployment prerequisites, post-deployment smoke and always-upload artifacts. No duplicate workflows or weakened assertions. Reports remain `artifacts/playwright/html/index.html`, `junit/results.xml`, `test-results/` and the separate local-smoke directory.

## 7. Completion gate and implementation report

Slice 4 is complete only after all editable fields and six status transitions work end to end, server-managed fields (`id`, `created_by`, `created_at`, `updated_at`, `seed_key`) remain protected, changes survive refresh/user switches/restart, errors preserve drafts, and all required regression/integration checks (including Slice 3 task creation) pass. Smoke must verify the editing interface without deployed writes.

### Implementation progress and verification summary

- **Backend & API (`src/types.go`, `src/tasks.go`, `src/tasks_test.go`, `src/tasks_contract_test.go`):**
  - Added `UpdateTaskInput` and `taskReader.Update` / `sqlTaskReader.Update` executing a single parameterized `UPDATE ... SET updated_at=CURRENT_TIMESTAMP WHERE id=$6 RETURNING ...` with UTC timestamp normalization.
  - Added `PUT /api/tasks/{id}` with shared path ID validation (`400 invalid_task_id`), `Content-Type: application/json` enforcement (`415 unsupported_media_type`), `64 KiB` body limit (`413 request_too_large`), single JSON object decoding, 200/2,000 Unicode rune boundaries, enum/ID checks, immutable/unknown key rejection (`400 validation_failed`), `sql.ErrNoRows` mapping (`404 not_found`), and PostgreSQL FK/check constraint mapping (`23503`/`23514`).
  - Added table-driven unit and contract tests in `src/tasks_test.go` and `src/tasks_contract_test.go`.
- **Frontend (`src/web/src/types.ts`, `src/web/src/taskApi.ts`, `src/web/src/TaskDetailsDialog.tsx`, `src/web/src/TaskBoard.tsx`, `src/web/src/App.css`):**
  - Added `TaskUpdateInput`, `fetchTask`, and `updateTask` serializing only editable fields and verifying returned task shape and ID.
  - Implemented `TaskDetailsDialog.tsx` with `GET /api/tasks/{id}` loading, read-only metadata (`Created by`, `Created`, `Last updated`), editable `Title`, `Description`, `Status`, `Priority`, and `Assignee` controls, client-side validation, 404 draft retention, and uncertain-save reconciliation (`Check latest task` / `Reload latest task`).
  - Updated `TaskBoard.tsx` and `App.css` with accessible card detail triggers, sibling quick `Status` `<select>` controls on each card, functional `replaceTaskById` updates, focus restoration after status transitions or dialog closure, and `invalidateInFlightLoad` generation guarding so stale GET refreshes never overwrite completed mutations.
- **Automated coverage & documentation (`tests/playwright/integration/task-fixture.spec.ts`, `tests/playwright/integration/tasks.spec.ts`, `tests/playwright/helpers/board.ts`, `tests/playwright/smoke/tasks.spec.ts`, `scripts/test-task-persistence.sh`, `docs/TESTING.md`, `AGENTS.md`, `src/AGENTS.md`, `src/web/AGENTS.md`):**
  - Added integration coverage in `task-fixture.spec.ts` for details editing, user reassignment, dialog status transitions, pointer/keyboard quick status controls, all six directed transitions, immutable field rejection, Unicode/field validation, 404 disappeared-task handling, narrow mobile viewport layout, and PUT failure/reconciliation/stale-GET resilience.
  - Updated `tasks.spec.ts` method restrictions for `PUT /api/tasks/{id}` and extended `expectBoard` in `helpers/board.ts` to assert each card's quick status value.
  - Extended `smoke/tasks.spec.ts` with non-destructive details dialog and quick-status checks under a fail-closed non-GET route guard, and extended `scripts/test-task-persistence.sh` to verify `PUT /api/tasks/{id}` updates across database restart, migration replay, and app restart.
- **Executed verification commands and results:**
  - `gofmt -w src/types.go src/tasks.go src/tasks_test.go src/tasks_contract_test.go`, `go -C src test ./...`, `go -C src vet ./...`, `go -C src build -o /tmp/cca-demo .` — **PASS**
  - `npm --prefix src/web run lint` (`eslint .`) and production TypeScript/Vite build (`tsc -b && vite build` in `src/Dockerfile`) — **PASS** (no frontend unit-test script exists in `src/web/package.json`)
  - Containerized Playwright integration suite (`npm run test:integration` on `recoverboard-test`) — **PASS (29/29 passed)**
  - Fixture restart and migration replay persistence check (`bash scripts/test-task-persistence.sh recoverboard-test`) — **PASS**
  - Containerized local smoke suite (`PW_SUITE=smoke BASE_URL=http://app:8080 PW_ARTIFACTS_DIR=/artifacts/local-smoke npm run test:smoke`) — **PASS (5/5 passed)**
  - Isolated stack cleanup (`down -v --remove-orphans`) — **PASS**
  - Remote post-deployment smoke (`BASE_URL=https://...`) was not executed locally because no external deployment target was supplied.
