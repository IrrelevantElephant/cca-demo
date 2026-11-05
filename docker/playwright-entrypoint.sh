#!/bin/sh
set -eu

if [ "${PW_SUITE:-integration}" = "integration" ]; then
  base_url="${BASE_URL:-http://app:8080}"
  export BASE_URL="$base_url"
  printf 'Waiting for RecoverBoard at %s\n' "$base_url"
  node -e '
    const url = process.env.BASE_URL;
    const deadline = Date.now() + 120000;
    async function wait() {
      while (Date.now() < deadline) {
        try {
          const response = await fetch(url + "/api/users", { signal: AbortSignal.timeout(3000) });
          if (response.ok) return;
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      console.error(`RecoverBoard did not become ready at ${url} within 120 seconds`);
      process.exit(1);
    }
    wait();
  '
fi

exec "$@"
