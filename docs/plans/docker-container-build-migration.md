# Plan: replace Nix container builds with Docker and Compose

## Goal and scope

Use the existing Dockerfiles as the single packaging path for local development, integration testing, and published production images. Running and testing the application should require Docker with Compose, not Nix or host Go/Node/pnpm installations.

Retain `flake.nix` and `flake.lock`: they remain useful for dependency/tool provisioning and shell helper scripts. Remove only the flake outputs and related configuration that build application/migration container images or provide the `compose-up` image-loading wrapper. Do not remove useful development dependencies, shell helpers, or credential/configuration features unless separately requested. This plan does not change application features, SQL contracts, infrastructure resources, deployment ordering, or development database storage.

## Current state and important gaps

- `flake.nix` builds the frontend, Go application, and migration images, and provides a `compose-up` wrapper that builds and loads image tarballs. The flake also has non-container dependencies and shell helpers that must remain.
- `src/Dockerfile` builds the frontend and Go binary in stages and runs as nonroot in a distroless image. It preserves `/app/web/dist`, `/app` as the working directory, and port 8080.
- `src/docker-compose.yaml` builds the app, but its migrator has only an image reference. App startup requires successful migrator completion.
- `src/Dockerfile.migrations` runs SQL and then sleeps indefinitely. The test overlay changes the app dependency to `service_started` to accommodate this. It is not currently a suitable production one-shot migration image.
- `.github/workflows/pipeline.yaml` uses Nix to build and push both images. Separately, it uses `nix shell` to supply Scaleway CLI and jq for the remote migration job.
- Integration and smoke tests already share a Docker-built Playwright runner. Preserve that architecture, lockfile, reports, isolation, and deployment gates.
- Nix dependency hashes and tool provisioning may still be needed by retained non-container flake outputs. Do not remove or rewrite them as part of eliminating container builders.

## Implementation sequence

### 1. Establish canonical Docker builds

Files: `src/Dockerfile`, `src/Dockerfile.migrations`, `src/.dockerignore`, optionally a migration entrypoint under `src/database/`, and `src/web/package.json` if a pnpm pin is needed.

- Reuse the existing multi-stage app Dockerfile rather than introducing a replacement build system.
- Review and pin compatible Go, Node, pnpm/Corepack, and runtime image versions; verify availability and compatibility with `src/go.mod` and the frontend lockfile. Add a pnpm `packageManager` pin if needed. Keep frozen-lockfile installs and Go module checksums; do not upgrade application dependencies incidentally.
- Preserve the nonroot runtime, static binary, asset layout, working directory, `PORT`, and case-sensitive `ConnectionString` contract. Verify CA certificates for production PostgreSQL TLS connectivity.
- Audit the build context exclusions for host `node_modules`, generated assets/binaries, environment files, and other unwanted inputs. Check the root Playwright context too, so state, credentials, and Nix result links are not sent unnecessarily. Do not remove required source or lockfiles.
- Keep frontend dependency and Go module layers cacheable. Ensure any pnpm cache mount actually matches the configured store.
- Make the migration image a genuine one-shot job, removing `sleep infinity` from its production entrypoint. Use `exec psql` and preserve required connection validation without logging the secret, `PGCONNECT_TIMEOUT=30`, `--no-psqlrc`, `ON_ERROR_STOP=1`, a single transaction, 60-second lock timeout, 120-second statement timeout, advisory lock `724195013`, execution of `database/schema.sql`, successful completion exit, and nonzero error exits.

### 2. Make plain Compose the local workflow

Files: `src/docker-compose.yaml`, `compose.test.yaml`.

- Add the migrator build definition to the base Compose file using the existing `src` context and `Dockerfile.migrations`.
- Retain image names, ports, database settings, watch behavior, and the PostgreSQL-health → migration-success → app-start chain.
- Document `docker compose -f src/docker-compose.yaml up --build` as the standard root-relative startup path.
- Remove redundant image/build definitions from the test overlay once they inherit correctly from the base file. Relative Compose paths resolve against the first Compose file (`src/docker-compose.yaml`).
- Restore successful migration completion as the integration app prerequisite; do not substitute readiness polling for migration failure propagation.
- Resolve the integration runner lifecycle deliberately: `up --abort-on-container-exit` can stop the stack when a correct one-shot migrator exits. Prefer starting the isolated app stack detached (with migration completion gating app startup), then running the existing Playwright service with `run --build --no-deps --rm`. Capture setup and test failures, collect logs, and always clean up only the test project. Validate this sequence with the supported Compose version.
- If the integration invocation changes, update both CI workflows, `docs/TESTING.md`, and root `AGENTS.md` together. Keep one shared Docker/Compose execution path locally and in CI.
- Preserve isolated test database storage and host-port removal. Do not add destructive cleanup to ordinary development.

### 3. Switch image publishing to Docker

Files: `.github/workflows/pipeline.yaml`; `.github/workflows/playwright-pr.yaml` if the shared test invocation changes.

- Replace the image job's Nix image-build/cache, `nix build`, and `docker load` steps with Docker Buildx builds from `src/Dockerfile` and `src/Dockerfile.migrations`, using `src` as context. Keep the Nix installation/tooling only if the workflow still needs it for retained non-container functionality; prefer explicit provisioning for deployment-only tools as described below.
- Publish the existing registry paths and release tags: `api:<version>`, `api:latest`, and `migrations:<version>`.
- Preserve `image_api` and `image_migrations` outputs and matching release versions passed to OpenTofu. Remove the misleading one-entry image matrix if it no longer helps.
- Explicitly target the production-supported architecture (currently x86_64 Linux); allow native local builds without promising untested multi-platform releases.
- Use separate BuildKit cache scopes for app and migration builds. Do not pass runtime credentials as build arguments or bake them into images.
- Preserve publishing prerequisites (`tag` and integration), deployment serialization, migration failure handling, post-deployment smoke tests, and always-uploaded reports.
- Verify integration uses the same Dockerfile recipes/build settings as published images; avoid test-only application images or entrypoints.

### 4. Retain the flake while removing its container-build machinery

Files: `flake.nix`, `flake.lock`, `.github/workflows/pipeline.yaml`, `init.sh`, and any references/documentation.

- Keep `flake.nix` and `flake.lock` in the repository. Preserve useful development dependencies, shell helpers, and other non-container outputs.
- Remove only outputs/derivations used to build the app and migration container images, their image tarball/load machinery, and the `compose-up` wrapper when no remaining consumer requires them. Keep shared dependencies that retained outputs still use; update `flake.lock` only if the flake inputs actually change.
- Replace the deployment job's `nix shell` invocation with explicitly versioned, verified provisioning of Scaleway CLI and jq on the CI runner, while retaining other Nix usage needed for retained flake utilities. Keep OpenTofu's existing setup action.
- Continue invoking `scripts/run-migration-job.sh` with the same outputs/environment and preserve bounded polling, timeout cleanup, and failure propagation. No infrastructure resource changes.
- Keep `init.sh` setup hints accurate: describe how to use retained optional cloud tooling and the flake helpers without implying that Nix is needed to build containers.
- Do not delete local result links, secrets, or infrastructure state as a side effect.

### 5. Update operational documentation

Files: root/scoped `AGENTS.md`, `docs/TESTING.md`, `docs/TECHDEBT.md`, and a concise root runbook if appropriate.

- Document prerequisites, root-relative build/start/stop/log commands, rebuild/watch behavior, and first-run migration behavior.
- Explain that regular shutdown must not delete development data; only the isolated integration project uses `down -v`.
- Document Docker-based Go test/vet and frontend lint/build checks, using existing builder stages or ephemeral tool containers without adding another framework.
- Replace claims about Nix image production and migration execution. Mark duplicate image-build and Nix-hash debt resolved only where appropriate; retain unrelated debt, especially production rollout-before-migration ordering.
- Make clear that retained Nix support is for non-container dependencies/helpers, not a second application image build path. Separate application development from cloud deployment credentials and tools.

## Validation and acceptance criteria

Run validation during implementation, not as a prerequisite to writing this plan.

1. **Configuration and clean builds:** validate base and merged Compose configuration; build both images from a clean checkout without prebuilt local images. Inspect runtime user, entrypoint, architecture, and asset layout. Confirm retained flake outputs/helpers still evaluate and run where applicable, and that no remaining output references removed image builders.
2. **Static/unit checks:** run `go test ./...`, `go vet ./...`, frontend lint, and frontend production build with containerized tooling. Report absent unit coverage rather than treating compilation as behavioral coverage.
3. **Migration lifecycle on disposable PostgreSQL:** verify success exits zero; missing/invalid connection configuration and SQL errors fail nonzero; migration failure blocks app startup; repeated application preserves unrelated inserted rows; and transaction rollback and timeout/lock settings remain correct. Never run these destructive/failure scenarios against development or production databases.
4. **Real-stack Playwright integration:** run all existing integration tests through the shared Compose architecture against the real app/API/PostgreSQL. Evaluate coverage for startup, bundled assets, `/api/users`, and saved user selection; extend tests only where packaging exposes a genuine gap. Add container-level migration failure/lifecycle checks because browser assertions alone cannot establish these guarantees.
5. **Runner failure propagation:** confirm setup failure, migration failure, unavailable app, and failing Playwright tests all produce nonzero overall status, preserve diagnostic artifacts, and clean up only isolated resources. Verify successful one-shot migration does not prematurely terminate the runner.
6. **Local smoke:** use the existing smoke image against a disposable running local app over a Docker-reachable URL/network. Smoke tests must change browser-local state only; do not run a browser on the host.
7. **CI and release:** review workflow syntax, tag/output wiring, and unchanged gates. After an authorized normal deployment, verify migration job completion and post-deployment smoke results. Do not apply infrastructure or start remote migrations merely to validate this refactor.
8. **Final audit:** confirm application packaging and CI image publication no longer call Nix image builders, `docker load`, or `compose-up`; ensure `flake.nix`/`flake.lock` remain and retained Nix consumers continue working.

Completion requires passing relevant checks, a Docker-only local start from a clean checkout, shared test/production image recipes, working one-shot migrations, unchanged API/UI behavior, and retained non-container flake functionality. Report tests added/modified/executed plus any checks blocked by Docker availability or deployment access.

## Rollout and rollback

Land the Docker/Compose migration and runner lifecycle fixes together before switching publishing. Then migrate publishing and remove only obsolete flake container-building outputs/wrappers, preserving the flake and lockfile. Keep the transition short and preserve required testing gates throughout.

Keep previous immutable release image references available. If a packaging regression occurs, revert the build/workflow change or redeploy the previous matching app/migration release through the authorized deployment process. Do not reset databases or automatically reverse schema changes. No schema changes are planned.

## Status

Plan revised to retain `flake.nix` and `flake.lock` for dependency provisioning and shell helper scripts while removing only container build outputs/wrappers. No implementation changes are made by this plan revision.
