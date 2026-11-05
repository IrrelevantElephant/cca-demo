#!/usr/bin/env bash
set -euo pipefail

job_id=${1:?Job definition ID required}
region=${2:?Region required}
run_id=$(scw jobs definition start "$job_id" region="$region" replicas=1 -o json |
  jq -er '.job_runs | if length == 1 then .[0].id else error("Expected one job run") end')
echo "Started migration job run: $run_id"

# Include queue time, but do not wait indefinitely if the job cannot be scheduled.
for ((attempt = 0; attempt < 84; attempt++)); do
  state=$(scw jobs run get "$run_id" region="$region" -o json | jq -er '.state')
  case "$state" in
    succeeded)
      echo "Database migrations succeeded."
      exit 0
      ;;
    failed|canceled|internal_error)
      echo "Migration job $run_id ended with state: $state" >&2
      exit 1
      ;;
    validated|queued|scheduled|running|unknown_state)
      sleep 10
      ;;
    *)
      echo "Unexpected migration job state: $state" >&2
      exit 1
      ;;
  esac
done

echo "Timed out waiting for migration job $run_id; stopping it." >&2
scw jobs run stop "$run_id" region="$region" >/dev/null
exit 1
