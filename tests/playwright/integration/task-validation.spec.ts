import { expect, test } from '@playwright/test';
import { getTasks } from '../helpers/api';

test('invalid fields are omitted with safe diagnostics and invalid-only initial data can recover', async ({ page, request }) => {
  const tasks = await getTasks(request);
  const errors: string[] = [];
  const warnings: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'warning') warnings.push(message.text()); });
  let payload: unknown = [{ ...tasks[0], status: 'invalid' }];
  await page.route('**/api/tasks', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: payload });
  });
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Invalid task data');
  await expect(page.getByText('No tasks yet', { exact: true })).toHaveCount(0);
  // A failed Retry must not claim to be showing stale data before any valid snapshot.
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('button', { name: 'Retry' })).toBeEnabled();
  await expect(page.getByRole('alert')).not.toContainText('stale');
  const patches = [{ id: -1 }, { id: 0 }, { id: 2147483648 }, { title: ' ' }, { description: 42 }, { status: ['todo'] }, { priority: 'urgent' }, { assigned_to: 0 }, { created_by: -1 }, { created_at: 'yesterday' }, { updated_at: '2025-01-01' }];
  payload = [tasks[0], ...patches.map((patch, index) => ({ ...tasks[0], id: 1000 + index, description: 'PRIVATE DESCRIPTION', ...patch })), null];
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.locator('.task-card')).toHaveCount(1);
  await expect(page.getByRole('status')).toHaveText(`${patches.length + 1} invalid task record(s) omitted.`);
  expect(warnings.length).toBeGreaterThan(0);
  expect(warnings.join('\n')).not.toContain('PRIVATE DESCRIPTION');
  payload = tasks;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('.task-card')).toHaveCount(tasks.length);
  await expect(page.getByRole('status')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('pending refresh retains cards, prevents duplicate requests and recovers from unusable refresh', async ({ page }) => {
  await page.goto('/');
  const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
  await expect(refresh).toBeEnabled();
  const titles = await page.locator('.task-card h3').allTextContents();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let count = 0;
  await page.route('**/api/tasks', async route => {
    count++;
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  try {
    await refresh.click();
    await expect(page.getByRole('status')).toHaveText('Refreshing tasks…');
    await expect(refresh).toBeDisabled();
    await expect(page.locator('.task-card h3')).toHaveText(titles);
    await page.getByLabel('Current user').selectOption('2');
    expect(count).toBe(1);
  } finally { release(); }
  await expect(refresh).toBeEnabled();
  await expect(page.getByLabel('Current user')).toHaveValue('2');
  await page.unroute('**/api/tasks');
  await page.route('**/api/tasks', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: [{ id: 1, status: 'invalid' }] });
  });
  await refresh.click();
  await expect(page.getByRole('alert')).toContainText('stale');
  await expect(page.getByRole('alert')).toContainText('Invalid task data');
  await expect(page.locator('.task-card h3')).toHaveText(titles);
  await page.unroute('**/api/tasks');
  await refresh.click();
  await expect(refresh).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('.task-card h3')).toHaveText(titles);
});
