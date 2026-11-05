# Slice 3 — Task creation implementation plan

## Scope and status

Planning only; no application changes or test execution are part of this planning task. Implement creation end to end while preserving user selection, task retrieval, board states, ordering, counts, and refresh. Editing, deletion, status changes, authentication, future slices, and deployment infrastructure changes remain out of scope.

## Repository findings

Inspected root, Go, and frontend `AGENTS.md` guides; Go routes/models/handlers/tests; schema, seeds and migration image; React state, board, API helper and CSS; Playwright suites/helpers/config/image; Compose; testing/debt documentation; and both CI workflows.

- Slice 2 exists and root/frontend guides now accurately describe the read-only board. `src/tasks.go` uses a testable reader interface, context-bound SQL, five-second timeouts, UTC serialization, and ascending creation-time/ID ordering.
- `002_tasks.sql` already has identity IDs, enum checks, nonempty titles, user foreign keys, timestamps, and stable `seed_key` seeding. Title/description maximum-length constraints are missing. Description is nullable in all existing response contracts.
- Contrary to the prompt's assumption, errors currently use plain-text `http.Error`; there is no existing JSON error envelope to reuse.
- `TaskBoard.tsx` owns the last-good snapshot and refresh state. Its pending-request guard currently drops overlapping loads; creation needs a guaranteed post-save refresh, not a dropped request.
- `App.tsx` supplies `users`, `selectedUser`, and selection changes through `UserContext`. Styling is plain CSS; there is no existing dialog/form library or frontend unit-test script.
- The existing runner includes `psql` and a separately guarded `fixture-app`/`fixture-database`. `task-fixture.spec.ts` destructively resets that fixture and must never overlap other fixture consumers. Ordinary regression tests compare a stable API snapshot to board counts.
- `integration/tasks.spec.ts` explicitly expects POST to return 405; this assertion must change for Slice 3.
- Existing smoke tests cover the board but do not explicitly retrieve task details; add a read-only detail check when a task exists. Both board integration and smoke tests now reuse `helpers/board.ts` (`expectBoard`) with `data-task-id` locators and captured API responses. Reuse these helpers; duplicate-title-safe assertions are already implemented. `helpers/api.ts` preserves sub-millisecond timestamp ordering, which concurrent creation tests must retain.
- CI already discovers integration/smoke specs, gates image publication/deployment on integration, runs smoke after migrations, and uploads reports. Both integration workflows now also gate on `scripts/test-task-persistence.sh` after Playwright and before cleanup. Preserve all these gates.
- The persistence script currently edits a fixture seed, restarts the fixture database, replays the real migration image, restarts the fixture app, and compares complete SQL snapshots. Extend this existing check for API-created task persistence rather than adding a competing restart mechanism; it does not yet verify creation or post-restart API availability.
- New `src/tasks_contract_test.go` and `integration/task-validation.spec.ts` strengthen error/context, malformed-read, pending-refresh, and duplicate-request coverage. Preserve and extend them rather than duplicating coverage.
- Recheck the current worktree before implementation and preserve unrelated work, including the Slice 4/5 plan documents. This review changes only this plan.

### Latest-code verification

The core design remains valid: there is still no create endpoint/dialog, length constraints remain absent, task errors are still plain text, and the board still needs a guaranteed post-save refresh. This plan has been refreshed to reuse the new board assertions and persistence gate, preserve the expanded method/seed/context/validation regression tests, and remove outdated documentation findings. This is static repository verification, not a claim that runtime tests passed.

## 1. Define validation and error contracts

- Accept exactly one JSON object containing `title`, optional `description`, `priority`, `assigned_to`, and `created_by`. Reject malformed/trailing JSON, arrays/scalars/null, unknown keys (including status, ID, timestamps), wrong types, and explicitly null field values. Omitted description stores NULL; an explicitly supplied empty string remains a string.
- Trim titles, reject whitespace-only titles, and enforce a maximum of 200 Unicode code points on the submitted title before normalization. Preserve description whitespace and enforce 2,000 code points. Match Go rune counts, JavaScript code-point counts, and PostgreSQL character counts; test non-ASCII boundaries.
- Require exact priority enums and positive integer user IDs within PostgreSQL INTEGER range; reject missing, fractional, negative, zero, and overflowing IDs. Use HTTP 400 for nonexistent user references consistently.
- Require a JSON content type (allow charset parameters), bound body size sufficiently for valid Unicode payloads, and return a documented 4xx for unsupported/oversized input. Use 400 for malformed JSON and field validation.
- Introduce a small shared JSON error writer, e.g. `{ "error": "validation_failed", "message": "Check the task fields.", "fields": { "title": "Title is required." } }`. Field errors are optional. Standardize application-generated task errors, including database setup failures, while preserving existing HTTP statuses; use the same helper for users where necessary for API consistency. Do not broadly redesign routing. Update affected tests and document this intentional error-body change.
- Keep unexpected failure messages generic and diagnostics server-side. Never return database details or connection strings.

## 2. Backend and database

Likely files: `src/tasks.go`, `src/types.go`, `src/tasks_test.go`, `src/tasks_contract_test.go`, a small error helper if useful, and `src/main.go` only where error consistency requires it. If extending the reader interface, update both `fakeTaskReader` and `contextTaskReader` test implementations without losing cancellation/deadline coverage.

1. Extend the existing task storage abstraction with Create (rename reader to store if clearer), retaining dependency-injected handler unit tests and existing GET behavior.
2. Register `POST /api/tasks` on the existing task mux. Use a dedicated creation DTO, not the response Task type, and strict decoding/validation before insertion.
3. Use one parameterized `INSERT ... RETURNING` with literal status `todo`, omitted identity/seed fields, and the existing timestamp defaults. A single statement is atomic; CURRENT_TIMESTAMP gives equal initial timestamps. Scan and normalize the returned task timestamps to UTC.
4. Validate user existence through the FK-enforced insert, mapping known `pq` foreign-key violations to actionable 400 errors for assignee/creator. This avoids a check/insert race; an optional precheck must not replace FK handling. Map known constraint failures appropriately and unexpected failures to 500.
5. Return the complete stored Task with HTTP 201, JSON content type, and `Location: /api/tasks/{id}`. Preserve nullable description and existing list order. Confirm immediate list/detail retrieval.
6. Add `src/database/migrations/003_task_creation_constraints.sql` for named maximum-length checks only; do not edit applied migrations. Make it repeatable through the repository's existing replay mechanism. Add it to `src/Dockerfile.migrations` and the fixture migration helper.
7. Preserve historical rows: use additive CHECK constraints marked NOT VALID if legacy overlength rows could exist, enforcing limits for new writes without rewriting/deleting old data. Verify fresh fixtures satisfy them; document subsequent validation rather than silently modifying legacy data. Keep old/new applications rollout-compatible and retain transactional advisory locking/timeouts.
8. Test replay, upgrade from Slice 2, unchanged seeds and unrelated rows, missing-user integrity, Unicode limits, and concurrent inserts with distinct generated IDs. Verify persistence across app restart in the isolated environment, without removing its database volume.

## 3. Creation UI and submission lifecycle

Likely files: new `src/web/src/CreateTaskDialog.tsx`; changes to `TaskBoard.tsx`, `taskApi.ts`, `types.ts`, and `App.css`.

- Place a prominent Create Task button in the existing board toolbar, retaining Refresh/Retry. Disable creation without a valid selected user.
- Prefer native `<dialog>` with `showModal()`, a labelled semantic form, associated field labels, visible error messages, and plain CSS responsive styling. No component library.
- Capture the selected creator ID/name when opening. Show noneditable “Creating as …” context; default assignee to that captured user and priority to medium. Keep creator stable if context changes while open; retain the chosen assignee. Reopening starts a fresh form using the then-current user.
- Provide title, multiline description, priority, and assignee controls sourced from existing users. No status or editable creator fields.
- Focus title on open, trap focus through modal semantics, support Tab/Shift+Tab and safe Escape/Cancel, and restore focus to the trigger. While submission is pending, disable controls/submission and prevent dismissal so a possibly committed request is not mistaken for cancellation.
- Run explicit client validation with actionable field errors and first-invalid-field focus. Use `aria-invalid`, `aria-describedby`, and live feedback. Ensure overlength input produces visible feedback rather than relying solely on silent maxlength truncation; keep Unicode counting consistent with the backend.
- Extend `taskApi.ts` with a typed create request/response and error parsing. Reuse task-response validation. Send one POST per deliberate submission, guarded synchronously as well as with disabled UI. Never automatically retry POST.
- On a definite 4xx/5xx response, keep the form/data, show the appropriate field/general error, and permit deliberate retry.
- Treat connection loss or unreadable success responses as potentially saved, not definite rejection. Preserve entered data, warn to check the board before resubmitting, and offer a nonmutating board-check action. Do not automatically POST again.
- On confirmed 201, close/reset the dialog, restore focus, announce “Task created successfully,” and refresh the board. Do not display unsaved optimistic cards.
- Refactor board loading to return an outcome and ensure a post-save GET actually occurs after any preexisting fetch (cancel superseded requests or queue the required reload). Prevent stale responses overwriting newer state; preserve StrictMode/unmount safety and last-good data.
- If that refresh fails, retain the successful creation result and show “Task saved, but the board could not be refreshed” with a GET-only retry action. Never reopen the saved form as a failed submission. On successful refresh, verify the created ID is present, counts update, and bring its card into view without changing established sort order.

## 4. Automated integration coverage and isolation

Use the existing package/image/config only. Core creation tests must hit real React, Go, and PostgreSQL.

### Fixture ownership

Reuse the existing isolated fixture, not another database stack or runner. Consolidate destructive fixture tests and new creation tests into one fixture-owning spec (optionally import test definitions from helper modules). Configure that file nonparallel with independent per-test setup/teardown rather than relying on previous tests' state. No other spec may target the fixture concurrently. Preserve existing migration/empty-state coverage during this refactor.

- Before/after each fixture test restore the known seeded baseline using the guarded SQL helper. Generate identifiable UUID-based task titles; clean even after assertions fail and reset before retries.
- Wait for fixture readiness before browser/API use. Keep SQL destination fixed and integration-only; never accept arbitrary BASE_URL or deployment credentials for cleanup.
- Keep ordinary regression tests on `app`, unchanged by fixture writes, so exact snapshot/count assertions remain meaningful.
- Always remove only isolated test volumes at run end, including on failures. Do not add a production DELETE endpoint.

### Coverage matrix

1. Alice creates a unique task with description/high priority assigned to Bob: assert 201, success announcement, To Do card, assignee/priority and count increment.
2. Reload and verify the same task; GET detail/list confirms all fields, creator, persisted description, Location, UTC/equal timestamps. Include isolated app-restart verification in the execution procedure.
3. Defaults for Alice and Bob, optional omitted description, different creator/assignee, and fresh defaults on reopen. Verify captured identity behavior if shared state changes while open; use a narrow component-state test if native modal interaction makes that impossible via ordinary UI.
4. Empty/whitespace title, 200/201-character title, 2,000/2,001-character description, Unicode boundaries, visible errors, and zero POSTs for invalid submissions.
5. API table-driven invalid cases: missing required fields, invalid enums, nonexistent IDs, null/wrong-type/fractional/overflow IDs, null/string violations, supplied status/ID/timestamps, unknown fields, malformed/trailing JSON, wrong top-level type, unsupported content type and oversized bodies. Check unchanged row count after rejected requests.
6. Delayed real POST: loading state, blocked duplicate click/Enter, safe dismissal behavior, exactly one created row. Concurrent valid API requests produce distinct IDs and persist independently.
7. Focus/autofocus, keyboard navigation, Escape/Cancel without writes, focus restoration, reopening, and narrow viewport layout.
8. Narrow failure-state interception only: definite API failure preserves form and supports retry; uncertain network outcome never auto-retries; successful real POST followed by failed board GET reports saved/stale state and GET-only retry. Explicitly distinguish these from core real-stack tests.
9. Go unit tests for decoding/validation, handler status/headers, generic errors, timeout/cancellation behavior, and storage error mapping. Use the existing fake abstraction; no new mocking dependency.
10. Run every existing regression test. In the current method/path matrix, change only POST `/api/tasks` from 405 to invalid-body 400 coverage; retain POST `/api/tasks/{id}` and PUT/PATCH/DELETE on both paths as 405. Preserve exact seeded-title and unchanged-list assertions on the ordinary app; all successful writes remain on the isolated fixture. Keep user persistence, task details, counts, empty states, manual refresh, malformed-read defenses, seed integrity, and the assertion that changing selected identity neither refetches nor filters tasks. Reuse `expectBoard` and retain sub-millisecond ordering checks.

## 5. Non-destructive smoke coverage

Add `tests/playwright/smoke/task-creation.spec.ts` using the existing smoke project:

- Open dialog, verify fields, priority options/default, user options/default, absence of status/editable creator, Cancel and reopen; test selected-user changes between opens.
- Submit only an empty/invalid form and verify visible feedback and zero create requests.
- Install a fail-closed POST guard in creation smoke tests: record and abort any attempted task creation request, then fail the test. This protects deployed data even if client validation regresses; it is not mocked successful write coverage.
- Preserve availability/users/identity/board/refresh tests; add GET detail coverage when records exist. Use stable task-ID locators to handle duplicate titles, without weakening contract assertions or assuming deployed seed counts.
- No SQL helpers, production mutations, privileged infrastructure access, or valid form submission in smoke.

## 6. Documentation and CI

- Root/frontend guides now correctly describe Slice 2; update their read-only wording only when Slice 3 is implemented. Clarify fixture ownership, cleanup, and limited failure-test interception. Update the migration command in `src/AGENTS.md` for migration 003. Existing mandatory testing/gating rules, including the persistence script, must remain.
- Correct `docs/TESTING.md`'s interception inventory: `task-validation.spec.ts` also intercepts read responses now; list the new isolated creation failure tests when added.
- Update `docs/TESTING.md` with the creation coverage, fixture serialization, new migration entry point, restart check and result-reporting expectations.
- Preserve package lockfiles and the common Docker runner; existing tooling should suffice. Update migration SQL copying/execution where needed, not runner dependencies without cause.
- Confirm new specs are discovered by current npm scripts in both workflows. No duplicate workflow, bypassed prerequisites, host browser execution, or deployment infrastructure edits.

## 7. Execution and completion gates

Run from the repository root unless noted:

1. Format Go; in `src`, run `go test ./...`, `go vet ./...`, and `go build -o /tmp/cca-demo .`. In `src/web`, run frozen-lockfile install, `pnpm lint`, and `pnpm build`. No frontend unit suite currently exists; report that accurately rather than claiming one ran.
2. Run the full containerized suite, collecting logs and preserving failure status:

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
   docker compose -p recoverboard-test -f src/docker-compose.yaml -f compose.test.yaml --profile integration down -v --remove-orphans || { cleanup_status=$?; [ "$status" -ne 0 ] || status=$cleanup_status; }
   exit "$status"
   ```

3. Before isolated-stack teardown, where practical, run local smoke against `http://app:8080` using the same Compose project/network and runner, with `PW_SUITE=smoke`, `BASE_URL=http://app:8080`, and `PW_ARTIFACTS_DIR=/artifacts/local-smoke`. Capture its exit status without obscuring integration failures. Extend `scripts/test-task-persistence.sh` for Slice 3: after destructive tests finish, create a uniquely identified task through the real fixture API using the existing container runner, retain its authoritative response, and preserve the script's database restart, migration replay, app restart, and complete SQL snapshot comparison. Wait for API readiness and retrieve the created task through GET after restart, asserting unchanged fields/ID/timestamps. Keep browser/API verification containerized, retain the test-project guard, do not give the runner a Docker socket, and clean the isolated volumes afterward. This persistence gate is mandatory, not an optional local check.
4. Post-deployment smoke uses the existing command unchanged:

   ```sh
   BASE_URL=https://your-host.example docker compose -p recoverboard-smoke -f src/docker-compose.yaml -f compose.test.yaml run --build --no-deps --rm -e PW_SUITE=smoke -e BASE_URL playwright npm run test:smoke
   ```

5. Retain HTML/JUnit/traces under `artifacts/playwright/`; report tests added/modified/executed, pass/fail, unrun checks, blockers and coverage gaps. Do not claim deployment tests ran during local work.

Completion requires validated atomic creation, creator capture, confirmed persistence/retrieval, correct To Do placement/counts, accessible validation/failure handling, unchanged existing behavior/seeds, isolated cleanup, nonmutating smoke coverage, and passing required containerized suites. The implementation report must list changed files, API/error-contract changes, migration details, test results, and outstanding assumptions.
