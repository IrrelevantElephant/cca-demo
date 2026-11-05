# Infrastructure and deployment

See [technical debt and pitfalls](../docs/TECHDEBT.md) for rollout ordering, migration limitations, and hardcoded configuration.

## Resources and configuration
- Use OpenTofu; CI pins version 1.11.8. Providers are pinned in `main.tf`, with selections recorded in `.terraform.lock.hcl`.
- `api.tf`: Scaleway serverless container, secret database connection, and custom domain.
- `database.tf`: serverless PostgreSQL, application IAM credentials/policy, and the connection-string secret.
- `migrations.tf`: separate migration job definition using a secret reference.
- `image-registry.tf` and `buckets.tf`: private registry and state bucket.
- `backend.tf` uses a remote S3-compatible Scaleway state backend. Treat state and plans as sensitive: credentials and connection strings can appear in them.
- `image_api` and `image_migrations` are required inputs. CI passes matching release tags using `TF_VAR_*`.
- Inspect variable/local references and backend settings before changing environment configuration; see `../docs/TECHDEBT.md`.

## Safe validation
From this directory:
- `tofu fmt -check` (or `tofu fmt` for intentional formatting edits).
- For local configuration validation without connecting to the remote backend: `tofu init -backend=false`, then `tofu validate`. Initialization still needs provider downloads/cache.
- A real `tofu plan -input=false` requires backend initialization, credentials, and image variables; it can contact live infrastructure. Only run it when authorized and configured for the intended environment.
- Never apply/destroy infrastructure or execute remote migration jobs merely to validate a code change. Do not expose secret values in logs or commit state/plan files.

## Deployment coupling
- `../.github/workflows/pipeline.yaml` tags a release, builds and pushes both Docker images, applies infrastructure, and then runs the migration job. Production deployments are serialized without canceling an in-progress deployment.
- `../.github/workflows/opentofu/action.yml` initializes, formats/checks, validates, plans, and applies on main.
- Preserve `ConnectionString` casing for both app and migration environments.
- Preserve outputs consumed by CI: `migration_job_id`, `region`, `organization_id`, and `project_id`.
- `../scripts/run-migration-job.sh` requires Scaleway CLI and jq, starts one replica, polls for success, fails on terminal errors/unexpected states, and stops the run on timeout. Do not weaken failure propagation or bounded waiting.
- The migration image is built from `../src/Dockerfile.migrations` and executes `../src/database/schema.sql`, not `seed.sql`.
- Keep schema changes additive and compatible with both old and new app versions; follow the rollout constraints in `../docs/TECHDEBT.md`.
