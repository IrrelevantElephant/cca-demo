# Repository guide

## Layout and conventions
- This cca-demo deployment of RecoverBoard lists database-backed team members, remembers the selected user, displays a shared task board with manual refresh and client-side filtering by assignee, status, and priority, supports creating tasks in the `todo` column (`POST /api/tasks`), supports task details editing and status transitions (`PUT /api/tasks/{id}`), and supports permanent task deletion with explicit confirmation (`DELETE /api/tasks/{id}`). The dashboard summary shows unfiltered task totals from the last valid board snapshot. Do not add business functionality unless requested.
- `src/`: Go HTTP server and PostgreSQL schema; see `src/AGENTS.md`.
- `src/web/`: React/TypeScript/Vite frontend; see its scoped guide.
- `infrastructure/`: OpenTofu/Scaleway resources; see `infrastructure/AGENTS.md`.
- `tests/playwright/`: shared TypeScript Playwright integration and smoke suites. Keep one package/image/config and preserve the lockfile.
- `src/docker-compose.yaml` is the canonical Docker build and local app workflow. Test Compose additions must not change ordinary development behavior.
- Keep SQL columns, Go JSON fields and TypeScript user contracts aligned. Never commit credentials/state or destroy development data.

## Interacting with the deployed app via Scaleway CLI
- Use the `scw` CLI to inspect or operate the deployed Scaleway Container instance. Authenticate and select the intended project/region before running commands; confirm the target container before making changes.
- In Scaleway Loki logs, the `resource_id` label for `resource_type="serverless_container"` is the Scaleway container ID and can be passed directly to `scw container container` commands. Prefer this ID from the relevant log evidence over treating `resource_name` as an ID. Before any mutation, inspect the ID with the CLI and verify its name, project, and region match the incident and intended target; do not rely on an ID alone.
- List matching containers and inspect the returned details:
  ```sh
  scw container container list name=cca-demo-api -o json | jq
  ```
- Redeploy (restart) the matching container using its ID:
  ```sh
  scw container container redeploy $(scw container container list name=cca-demo-api -o json | jq '.[0].id' -r)
  ```
  This selects the first match, so verify the list contains the intended single container before running it. Redeployment affects the live app and may briefly interrupt service; use only when operationally appropriate. Do not expose or commit credentials, and do not use this as a substitute for isolated incident testing.

## Agentic plans
Store agentic plans in `./docs/plans` (repository-root-relative). Keep plans in that directory rather than elsewhere in the repository.

## Mandatory functionality testing
Every application functionality change must evaluate existing Playwright coverage: add tests for new behavior, update tests affected by behavior changes, and remove tests only when that behavior has genuinely retired. Run relevant tests before completion. Frontend/API/database-backed behavior requires Playwright integration coverage against the real React app, real Go API and PostgreSQL—do not mock those components. Critical user journeys should have non-destructive post-deployment smoke coverage where appropriate.

**All Playwright integration and smoke tests must be built and executed as containers using the repository's existing Docker Compose architecture.** Maintain `Dockerfile.playwright`, `compose.test.yaml` and the common image for both suites. Use the same Docker execution locally and in CI; no host Playwright/browser execution or duplicate runner infrastructure. Docker and Docker Compose alone must suffice; update the image when dependencies change.

Integration tests use an isolated Compose project and database volume. Smoke tests target an externally deployed URL, change browser-local state only, and run after deployment; no privileged infrastructure access. Preserve GitHub Actions testing gates: do not disable/skip tests, weaken assertions, or bypass deployment prerequisites to mask failures.

## Verified test commands and reporting
Run from repository root (Docker daemon required):
- All integration tests: start with `docker compose -p recoverboard-test -f src/docker-compose.yaml -f compose.test.yaml --profile integration up --build -d app`, then run the runner with `docker compose -p recoverboard-test -f src/docker-compose.yaml -f compose.test.yaml --profile integration run --build --no-deps --rm playwright npm run test:integration`; collect logs and always clean using `down -v --remove-orphans`, preserving the initial status. This keeps the successful one-shot migrator from terminating the runner. After the suite and before cleanup, run `bash scripts/test-task-persistence.sh recoverboard-test` to verify fixture restart/migration preservation (also gated in CI).
- Smoke tests: `BASE_URL=https://your-host.example docker compose -p recoverboard-smoke -f src/docker-compose.yaml -f compose.test.yaml run --build --no-deps --rm -e PW_SUITE=smoke -e BASE_URL playwright npm run test:smoke`.
- Individual test: run the isolated app stack then `docker compose -p recoverboard-test -f src/docker-compose.yaml -f compose.test.yaml run --build --no-deps --rm playwright npm run test:integration -- --grep 'persists selection'`.
- Reports: `artifacts/playwright/html/index.html`, JUnit at `artifacts/playwright/junit/results.xml`; traces/screenshots are under `artifacts/playwright/test-results/`.
- Cleanup: use the integration `down -v --remove-orphans` command above. It removes only the isolated test project/volume.

Before declaring functionality complete: run relevant unit tests, the integration suite through Docker Compose, and local-app smoke tests where practical; verify existing behavior and report pass/fail plus tests not run and coverage gaps. Never claim unexecuted tests passed. Include a testing summary of tests added/modified/executed and outstanding gaps.
