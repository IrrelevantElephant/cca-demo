# Technical debt and known pitfalls

This document collects issues identified during the repository review. These are current limitations and proposed follow-ups, not completed fixes. Paths below are relative to the repository root. Operational instructions remain in the scoped `AGENTS.md` files.

## Local development and packaging


### Standalone Vite does not connect to the API
- **Location:** `src/web/vite.config.ts`, `src/web/src/App.tsx`.
- **Issue:** The frontend fetches same-origin `/api/users`, but Vite has no API proxy. Standalone dev/preview servers do not provide that endpoint.
- **Workaround:** Use Compose or build the assets and serve them through Go.
- **Follow-up:** Configure a development API proxy and document the two-server workflow; keep production requests same-origin. Preview needs its own routing arrangement.

### Build artifacts and duplicate packaging paths
- **Location:** `src/src`, `src/Dockerfile`, `.github/workflows/pipeline.yaml`.
- **Issue:** `src/src` is a tracked compiled executable. Bare `go build` inside `src/` can overwrite it.
- **Workaround:** Use `go build -o /tmp/cca-demo .` from `src/`.
- **Status:** Duplicate Nix/Docker image builds are resolved; Compose and CI now share Dockerfiles.


## Database and deployment

### Production app rollout precedes migrations
- **Location:** `.github/workflows/pipeline.yaml`, `.github/workflows/opentofu/action.yml`, `infrastructure/migrations.tf`.
- **Issue:** Infrastructure apply can deploy the new app before the workflow starts the migration job. Applying the job definition does not execute it. Local Compose uses a different order: migration success gates app startup.
- **Impact:** Code requiring a new schema can fail during production rollout even if local startup succeeds.
- **Workaround:** Keep schema changes additive and compatible with old and new app versions.
- **Follow-up:** Establish an explicit expand/migrate/deploy/contract process or another safe rollout strategy. Preserve serialized deployments and migration failure propagation.

### Unversioned schema and duplicated seed data
- **Location:** `src/database/schema.sql`, `src/database/seed.sql`, migration runner in `src/Dockerfile.migrations`.
- **Issue:** The migration runner replays `schema.sql`; there is no versioned migration history. User upserts are duplicated in `seed.sql`, which the migration image does not separately execute. Replaying the schema overwrites names and roles for the predefined user IDs.
- **Workaround:** Keep SQL repeatable and additive, synchronize shared seed definitions, and test repeated execution and preservation of unrelated rows against a disposable database.
- **Follow-up:** Separate demo seeding from schema evolution and adopt versioned migrations when needed. Preserve transactionality, advisory locking, timeouts, and fail-fast behavior.

### Infrastructure configuration has hardcoded and ineffective inputs
- **Location:** `infrastructure/variables.tf`, `infrastructure/locals.tf`, `infrastructure/backend.tf`, `infrastructure/api.tf`.
- **Issue:** Project/organization identifiers, backend settings, and the domain are tied to the current deployment. Resource names use `local.project_name` rather than the declared `var.project_name`.
- **Impact:** Changing the project-name variable alone does not rename resources; copying the configuration can still target existing infrastructure/state.
- **Follow-up:** Consolidate environment configuration and remove or connect ineffective inputs. Review resource replacement and state implications before changing names or backend settings.

## Verification and documentation

### Application test coverage is not established
- **Location:** `src/`, `src/web/package.json`, `.github/workflows/pipeline.yaml`.
- **Issue:** There are no application test files or frontend test script. The deployment workflow does not explicitly run frontend lint or Go vet; a successful build is not behavioral coverage.
- **Follow-up:** Add backend handler/database tests and frontend tests for loading, selection persistence, empty/malformed/error responses, and retry. Add explicit CI checks and a disposable-database migration repeatability check.
- **Until then:** Run available build/lint/vet checks and manually verify affected UI/API behavior. State exactly which checks ran.

### Frontend README is starter documentation
- **Location:** `src/web/README.md`.
- **Issue:** The README describes the Vite template rather than application setup or the API workflow.
- **Follow-up:** Replace it with an application runbook covering environment variables, database setup, frontend/backend development, and verification.

## Architectural boundaries to keep in mind

These are current design constraints, not necessarily defects:
- **Static serving:** `src/main.go` serves `./web/dist` from the working directory; assets are not embedded and there is no SPA fallback. Preserve the runtime asset layout, and add fallback routing deliberately if client-side routes are introduced.
- **User selection is not authentication:** `src/web/src/App.tsx` persists a selected user ID in localStorage. Neither that ID nor a displayed role establishes authorization; add server-side authentication/authorization before relying on identity for protected operations.
- **Shared contracts are manual:** SQL columns, Go JSON fields, and TypeScript types must be kept aligned. Consider contract tests or generated types as the API grows.
- Docker base/tool versions and committed package lockfiles govern Docker image builds. The retained Nix flake still has dependency hashes for its frontend/Go development outputs; keep those hashes current when changing dependencies. Production image publication targets linux/amd64; local Docker builds use the host's native architecture.
