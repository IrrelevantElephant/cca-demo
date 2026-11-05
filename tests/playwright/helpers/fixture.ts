import { execFileSync } from 'node:child_process';
import { expect, type APIRequestContext } from '@playwright/test';

// Deliberately not configurable: destructive setup must never target the main app or deployment.
const connection = 'postgresql://postgres:fixture-password@fixture-database:5432/recoverboard-fixture?sslmode=disable';
export const fixtureURL = 'http://fixture-app:8080';

export function sql(statement: string): string {
  const target = new URL(connection);
  if (process.env.PW_SUITE !== 'integration' || target.hostname !== 'fixture-database' || target.pathname !== '/recoverboard-fixture') {
    throw new Error('SQL setup is restricted to the isolated integration fixture');
  }
  return execFileSync('psql', [connection, '-X', '-v', 'ON_ERROR_STOP=1', '-At'], { input: statement, encoding: 'utf8' }).trim();
}

export function migrate(): void {
  sql('BEGIN;\n\\i /fixtures/database/schema.sql\n\\i /fixtures/database/migrations/002_tasks.sql\n\\i /fixtures/database/migrations/003_task_creation_constraints.sql\nCOMMIT;');
}

export function resetFixture(): void {
  sql('BEGIN;\nDROP TABLE IF EXISTS tasks, seed_metadata;\nDELETE FROM users WHERE id NOT IN (1, 2, 3);\nCOMMIT;');
  migrate();
}

export async function waitForFixture(request: APIRequestContext): Promise<void> {
  await expect.poll(async () => {
    try {
      const [users, tasks] = await Promise.all([
        request.get(`${fixtureURL}/api/users`),
        request.get(`${fixtureURL}/api/tasks`),
      ]);
      return users.status() === 200 && tasks.status() === 200;
    } catch {
      return false;
    }
  }, { timeout: 15_000 }).toBe(true);
}
