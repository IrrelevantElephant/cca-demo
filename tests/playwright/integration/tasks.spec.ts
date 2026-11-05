import { expect, test } from '@playwright/test';
import { getTasks, getUsers } from '../helpers/api';
import { expectBoard } from '../helpers/board';

const seedTitles = ['Prepare recovery plan', 'Audit dependencies', 'Update documentation', 'Review pull requests', 'Restore staging environment', 'Check monitoring', 'Resolve login issue', 'Validate backups', 'Close old incidents', 'Plan team handoff'];

test('task API contract, seed data, detail validation and method restrictions', async ({ request }) => {
  const tasks = await getTasks(request);
  const users = await getUsers(request);
  expect(tasks.map(task => task.title).sort()).toEqual([...seedTitles].sort());
  for (const task of tasks) {
    expect(users.map(user => user.id)).toContain(task.assigned_to);
    expect(users.map(user => user.id)).toContain(task.created_by);
    const detail = await request.get(`/api/tasks/${task.id}`);
    expect(detail.status()).toBe(200);
    expect(await detail.json()).toEqual(task);
  }
  for (const id of ['x', '+1', '-1', '0', '1.0', '1e1', '2147483648', '999999999999999999999']) {
    expect((await request.get(`/api/tasks/${id}`)).status()).toBe(400);
  }
  expect(tasks.some(task => task.id === 2147483647)).toBe(false);
  expect((await request.get('/api/tasks/2147483647')).status()).toBe(404);
  const invalidCreate = await request.fetch('/api/tasks', { method: 'POST', data: {} });
  expect(invalidCreate.status()).toBe(400);
  expect(invalidCreate.headers()['content-type']).toContain('application/json');
  const invalidUpdate = await request.fetch(`/api/tasks/${tasks[0].id}`, { method: 'PUT', data: {} });
  expect(invalidUpdate.status()).toBe(400);
  expect(invalidUpdate.headers()['content-type']).toContain('application/json');
  expect((await request.fetch(`/api/tasks/${tasks[0].id}`, { method: 'POST', data: {} })).status()).toBe(405);
  expect((await request.fetch('/api/tasks', { method: 'PUT', data: {} })).status()).toBe(405);
  expect((await request.fetch('/api/tasks', { method: 'DELETE' })).status()).toBe(405);
  for (const path of ['/api/tasks', `/api/tasks/${tasks[0].id}`]) {
    expect((await request.fetch(path, { method: 'PATCH', data: {} })).status()).toBe(405);
  }
  for (const id of ['x', '+1', '-1', '0', '1.0', '1e1', '2147483648', '999999999999999999999']) {
    const badDelete = await request.delete(`/api/tasks/${id}`);
    expect(badDelete.status()).toBe(400);
    expect(badDelete.headers()['content-type']).toContain('application/json');
  }
  const missingDelete = await request.delete('/api/tasks/2147483647');
  expect(missingDelete.status()).toBe(404);
  expect(missingDelete.headers()['content-type']).toContain('application/json');
  expect(await getTasks(request)).toEqual(tasks);
});

test('shared board preserves order and identity through keyboard refresh on mobile', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const tasks = await getTasks(request);
  const users = await getUsers(request);
  let taskRequests = 0;
  page.on('request', request => { if (request.url().endsWith('/api/tasks')) taskRequests++; });
  await page.goto('/');
  await expectBoard(page, tasks, users);
  const initialRequests = taskRequests;
  const selected = page.getByLabel('Current user');
  for (const user of users) {
    await selected.selectOption(String(user.id));
    await expect(page.locator('.current-user strong')).toHaveText(user.name);
    expect(await page.evaluate(() => localStorage.getItem('recoverboard.selectedUserId'))).toBe(String(user.id));
    await expectBoard(page, tasks, users);
  }
  expect(taskRequests).toBe(initialRequests);
  await page.setViewportSize({ width: 320, height: 700 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await selected.focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(selected).toHaveValue(String(users[1].id));
  await page.evaluate(() => { (window as Window & { lifetime?: string }).lifetime = 'same-document'; });
  const response = page.waitForResponse(r => r.url().endsWith('/api/tasks'));
  await page.getByRole('button', { name: 'Refresh', exact: true }).focus();
  await page.keyboard.press('Enter');
  expect((await response).status()).toBe(200);
  await expectBoard(page, tasks, users);
  expect(taskRequests).toBe(initialRequests + 1);
  expect(await page.evaluate(() => (window as Window & { lifetime?: string }).lifetime)).toBe('same-document');
  await expect(selected).toHaveValue(String(users[1].id));
  expect(errors).toEqual([]);
});
