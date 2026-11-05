import { expect, type APIRequestContext } from '@playwright/test';

export type ApiTask = { id: number; title: string; description: string | null; status: 'todo' | 'in_progress' | 'done'; priority: 'low' | 'medium' | 'high'; assigned_to: number; created_by: number; created_at: string; updated_at: string };

export async function getTasks(request: APIRequestContext, baseUrl = ''): Promise<ApiTask[]> {
  const response = await request.get(`${baseUrl}/api/tasks`);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('application/json');
  const payload: unknown = await response.json();
  return assertTasks(payload);
}

export function assertTask(value: unknown): ApiTask {
  return assertTasks([value])[0];
}

export function assertTasks(payload: unknown): ApiTask[] {
  expect(Array.isArray(payload)).toBe(true);
  const tasks = payload as ApiTask[];
  const ids = new Set<number>();
  for (const task of tasks) {
    expect(Object.keys(task).sort()).toEqual(['id', 'title', 'description', 'status', 'priority', 'assigned_to', 'created_by', 'created_at', 'updated_at'].sort());
    for (const id of [task.id, task.assigned_to, task.created_by]) {
      expect(Number.isInteger(id)).toBe(true);
      expect(id).toBeGreaterThan(0);
      expect(id).toBeLessThanOrEqual(2147483647);
    }
    expect(ids.has(task.id)).toBe(false);
    ids.add(task.id);
    expect(typeof task.title).toBe('string');
    expect(task.title.trim().length).toBeGreaterThan(0);
    expect(task.description === null || typeof task.description === 'string').toBe(true);
    expect(['todo', 'in_progress', 'done']).toContain(task.status);
    expect(['low', 'medium', 'high']).toContain(task.priority);
    for (const timestamp of [task.created_at, task.updated_at]) {
      expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
      expect(Number.isFinite(Date.parse(timestamp))).toBe(true);
    }
  }
  // Preserve PostgreSQL sub-millisecond ordering instead of truncating through Date.parse.
  const timeKey = (value: string) => value.slice(0, 19) + (value.slice(19, -1).replace('.', '')).padEnd(9, '0');
  expect(tasks.map(task => task.id)).toEqual([...tasks].sort((a, b) => timeKey(a.created_at).localeCompare(timeKey(b.created_at)) || a.id - b.id).map(task => task.id));
  return tasks;
}

export async function getUsers(request: APIRequestContext, baseUrl = '') {
  const response = await request.get(`${baseUrl}/api/users`);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('application/json');
  return response.json() as Promise<Array<{ id: number; name: string; role: string }>>;
}
