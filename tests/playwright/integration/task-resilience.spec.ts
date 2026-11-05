import { expect, test } from '@playwright/test';

// Narrow frontend-defense exception: forward the actual API response, changing only its payload in this spec.
test('omits malformed task records while retaining valid records and reports invalid-only payloads', async ({ page }) => {
  let mode: 'mixed' | 'invalid' = 'mixed';
  await page.route('**/api/tasks', async route => {
    const upstream = await route.fetch();
    const original: Array<Record<string, unknown>> = await upstream.json();
    const altered = mode === 'mixed'
      ? [...original.slice(0, 1), { ...original[0], id: -1, status: 'surprise' }]
      : [{ id: 77, title: '', description: null, status: 'unknown', priority: 'none', assigned_to: 1, created_by: 1, created_at: 'bad', updated_at: 'bad' }];
    await route.fulfill({ response: upstream, json: altered });
  });
  await page.goto('/');
  await expect(page.getByText(/invalid task record/i)).toBeVisible();
  await expect(page.locator('.task-card')).toHaveCount(1);
  mode = 'invalid';
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('alert')).toContainText(/could not be refreshed/i);
  await expect(page.locator('.task-card')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'RecoverBoard' })).toBeVisible();
});

test('rejects non-array, duplicate, invalid-enum and unknown-assignee payloads safely', async ({ page, request }) => {
  const upstream = await request.get('/api/tasks');
  const tasks: Array<Record<string, unknown>> = await upstream.json();
  expect(tasks.length).toBeGreaterThan(0);
  let payload: unknown = { tasks };
  await page.route('**/api/tasks', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: payload });
  });
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText(/could not be loaded/i);
  payload = [
    { ...tasks[0], assigned_to: 2147483000 },
    { ...tasks[0] },
    { ...tasks[0], id: 2147483001, priority: 'urgent' },
    { ...tasks[0], id: 2147483002, status: 'invalid' },
  ];
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByText(/invalid task record/i)).toBeVisible();
  await expect(page.locator('.task-card')).toHaveCount(1);
  await expect(page.locator('.task-card')).toContainText('Unknown user');
  await expect(page.getByLabel('Current user')).toBeVisible();
});

test('shows loading while the real task response is delayed', async ({ page }) => {
  await page.route('**/api/tasks', async route => {
    await new Promise(resolve => setTimeout(resolve, 350));
    await route.continue();
  });
  await page.goto('/');
  await expect(page.getByRole('status')).toHaveText('Loading tasks…');
  await expect(page.getByText('No tasks yet', { exact: true })).toHaveCount(0);
  await expect(page.getByText('No tasks in this column.', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry' })).toBeDisabled();
  await expect(page.getByRole('heading', { name: 'To do' })).toBeVisible();
});

test('failed refresh retains the last good board and reports stale data', async ({ page }) => {
  let fail = false;
  await page.route('**/api/tasks', async route => {
    if (fail) { await route.abort(); return; }
    await route.continue();
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'To do' })).toBeVisible();
  const cards = await page.locator('.task-card h3').allTextContents();
  fail = true;
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('alert')).toContainText(/could not be refreshed/i);
  await expect(page.locator('.task-card h3')).toHaveText(cards);
});

test('retries an initial task-fetch failure against the real backend', async ({ page }) => {
  let fail = true;
  await page.route('**/api/tasks', async route => {
    if (fail) { fail = false; await route.abort(); return; }
    await route.continue();
  });
  await page.goto('/');
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('heading', { name: 'To do' })).toBeVisible();
});
