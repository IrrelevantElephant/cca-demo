#!/usr/bin/env bash
# Run after the integration suite, never concurrently with its serial SQL fixture.
# No Docker socket or infrastructure access is given to the Playwright runner.
set -euo pipefail
project=${1:?Supply the isolated integration Compose project name}
case "$project" in recoverboard-test|recoverboard-test-*) ;; *) echo 'Refusing non-test Compose project' >&2; exit 1;; esac
cd "$(dirname "$0")/.."
compose() { docker compose -p "$project" -f src/docker-compose.yaml -f compose.test.yaml --profile integration "$@"; }
sql() { compose exec -T fixture-database psql -X -v ON_ERROR_STOP=1 -U postgres -d recoverboard-fixture -Atc "$1"; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

compose run --no-deps --rm --entrypoint node playwright -e '
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
(async () => {
  const base = "http://fixture-app:8080";
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${base}/api/tasks`);
      if (r.status === 200) break;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  const payload = {
    title: `Restart created task ${randomUUID()}`,
    description: "Persisted across fixture database/app restart and migration replay",
    priority: "high",
    assigned_to: 2,
    created_by: 1,
  };
  const res = await fetch(`${base}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(res.status, 201);
  const created = await res.json();
  assert.equal(res.headers.get("location"), `/api/tasks/${created.id}`);
  assert.equal(created.title, payload.title);
  assert.equal(created.description, payload.description);
  assert.equal(created.status, "todo");
  assert.equal(created.priority, payload.priority);
  assert.equal(created.assigned_to, payload.assigned_to);
  assert.equal(created.created_by, payload.created_by);
  assert.equal(created.created_at, created.updated_at);

  const updatePayload = {
    title: `Restart updated task ${randomUUID()}`,
    description: "Edited via PUT and persisted across fixture database/app restart and migration replay",
    status: "in_progress",
    priority: "medium",
    assigned_to: 3,
  };
  const putRes = await fetch(`${base}/api/tasks/${created.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updatePayload),
  });
  assert.equal(putRes.status, 200);
  const updated = await putRes.json();
  assert.equal(updated.id, created.id);
  assert.equal(updated.title, updatePayload.title);
  assert.equal(updated.description, updatePayload.description);
  assert.equal(updated.status, updatePayload.status);
  assert.equal(updated.priority, updatePayload.priority);
  assert.equal(updated.assigned_to, updatePayload.assigned_to);
  assert.equal(updated.created_by, created.created_by);
  assert.equal(updated.created_at, created.created_at);

  const deleteTargetRes = await fetch(`${base}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: `Restart deleted task ${randomUUID()}`,
      description: "Deleted via DELETE and must stay absent across restart and migration replay",
      priority: "low",
      assigned_to: 1,
      created_by: 2,
    }),
  });
  assert.equal(deleteTargetRes.status, 201);
  const deleteTarget = await deleteTargetRes.json();
  const delRes = await fetch(`${base}/api/tasks/${deleteTarget.id}`, { method: "DELETE" });
  assert.equal(delRes.status, 204);
  assert.equal(await delRes.text(), "");
  const checkDelRes = await fetch(`${base}/api/tasks/${deleteTarget.id}`);
  assert.equal(checkDelRes.status, 404);

  const listBeforeRes = await fetch(`${base}/api/tasks`);
  assert.equal(listBeforeRes.status, 200);
  const listBefore = await listBeforeRes.json();
  const seedToDelete = listBefore.find(t => t.title === "Audit dependencies");
  assert.ok(seedToDelete, "Expected seeded task Audit dependencies to exist before deletion");
  const delSeedRes = await fetch(`${base}/api/tasks/${seedToDelete.id}`, { method: "DELETE" });
  assert.equal(delSeedRes.status, 204);
  assert.equal(await delSeedRes.text(), "");

  process.stdout.write(JSON.stringify({ updated, deletedId: deleteTarget.id, deletedSeedId: seedToDelete.id }));
})().catch(err => { console.error(err); process.exit(1); });
' > "$tmp/created.json"

sql "UPDATE tasks SET title='Restart preservation check',updated_at='2020-01-01T00:00:00Z' WHERE seed_key='recoverboard:slice2:01'" > /dev/null
sql 'SELECT json_agg(t ORDER BY id) FROM tasks t' > "$tmp/before"
compose restart fixture-database
ready=false
for attempt in {1..60}; do
  if compose exec -T fixture-database pg_isready -q -U postgres -d recoverboard-fixture; then ready=true; break; fi
  sleep 1
done
[ "$ready" = true ] || { echo 'Fixture database did not restart' >&2; exit 1; }
# Re-run the actual migration image as an ordinary app restart/redeploy would.
compose run --no-deps --rm fixture-migrator
compose restart fixture-app
sql 'SELECT json_agg(t ORDER BY id) FROM tasks t' > "$tmp/after"
diff -u "$tmp/before" "$tmp/after"

compose run --no-deps --rm --entrypoint node playwright -e '
const assert = require("node:assert/strict");
const { updated: expected, deletedId, deletedSeedId } = JSON.parse(process.argv[1]);
(async () => {
  const base = "http://fixture-app:8080";
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/api/tasks`);
      if (r.status === 200) { ready = true; break; }
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  assert.equal(ready, true, "Fixture app did not become ready after restart");

  const detailRes = await fetch(`${base}/api/tasks/${expected.id}`);
  assert.equal(detailRes.status, 200);
  const detail = await detailRes.json();
  assert.deepStrictEqual(detail, expected);

  const deletedDetailRes = await fetch(`${base}/api/tasks/${deletedId}`);
  assert.equal(deletedDetailRes.status, 404);
  const deletedSeedDetailRes = await fetch(`${base}/api/tasks/${deletedSeedId}`);
  assert.equal(deletedSeedDetailRes.status, 404);

  const listRes = await fetch(`${base}/api/tasks`);
  assert.equal(listRes.status, 200);
  const list = await listRes.json();
  const fromList = list.find(t => t.id === expected.id);
  assert.deepStrictEqual(fromList, expected);
  assert.equal(list.some(t => t.id === deletedId), false);
  assert.equal(list.some(t => t.id === deletedSeedId), false);
})().catch(err => { console.error(err); process.exit(1); });
' "$(cat "$tmp/created.json")"

echo 'Task IDs, API-created tasks, edited data, deletions and timestamps survived restart and migration replay.'
