import { expect, test } from '@playwright/test';
import { assertTask, assertTasks, getTasks, getUsers } from '../helpers/api';
import { expectBoard, expectDashboardSummary } from '../helpers/board';

test('task board matches captured responses, verifies detail endpoint and refresh preserves identity without navigation', async ({ page, request }) => {
  const tasks = await getTasks(request);
  const users = await getUsers(request);
  if (tasks.length > 0) {
    const detail = await request.get(`/api/tasks/${tasks[0].id}`);
    expect(detail.status()).toBe(200);
    expect(detail.headers()['content-type']).toContain('application/json');
    expect(assertTask(await detail.json())).toEqual(tasks[0]);
  }
  const loaded = page.waitForResponse(r => r.url().endsWith('/api/tasks') && r.request().method() === 'GET');
  await page.goto('/');
  const response = await loaded;
  expect(response.status()).toBe(200);
  await expectBoard(page, assertTasks(await response.json()), users);
  const selector = page.getByLabel('Current user');
  const identity = String(users[users.length - 1].id);
  await selector.selectOption(identity);
  const reloaded = page.waitForResponse(r => r.url().endsWith('/api/tasks'));
  await page.reload();
  await expectBoard(page, assertTasks(await (await reloaded).json()), users);
  await expect(selector).toHaveValue(identity);
  await page.evaluate(() => { (window as Window & { lifetime?: string }).lifetime = 'same-document'; });
  const refreshed = page.waitForResponse(r => r.url().endsWith('/api/tasks') && r.request().method() === 'GET');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  const refreshResponse = await refreshed;
  expect(refreshResponse.status()).toBe(200);
  await expectBoard(page, assertTasks(await refreshResponse.json()), users);
  expect(await page.evaluate(() => (window as Window & { lifetime?: string }).lifetime)).toBe('same-document');
  await expect(selector).toHaveValue(identity);
});

test('non-destructive task details dialog, quick status control availability, validation and fail-closed write guard', async ({ page, request }) => {
  const users = await getUsers(request);
  expect(users.length).toBeGreaterThan(0);

  const attemptedMutations: string[] = [];
  await page.route('**/api/tasks*', async route => {
    if (route.request().method() !== 'GET') {
      attemptedMutations.push(`${route.request().method()} ${route.request().url()}`);
      await route.abort();
      return;
    }
    await route.continue();
  });

  const loaded = page.waitForResponse(r => r.url().endsWith('/api/tasks') && r.request().method() === 'GET');
  await page.goto('/');
  const liveTasks = assertTasks(await (await loaded).json());
  await expectBoard(page, liveTasks, users);

  if (liveTasks.length === 0) {
    await expect(page.getByText('No tasks yet', { exact: true })).toBeVisible();
    expect(attemptedMutations).toEqual([]);
    return;
  }

  const target = liveTasks[0];
  const card = page.locator(`.task-card[data-task-id="${target.id}"]`);
  const quickSelect = card.getByLabel('Status');
  await expect(quickSelect).toBeEnabled();
  await expect(quickSelect).toHaveValue(target.status);
  await expect(quickSelect.locator('option')).toHaveText(['To do', 'In progress', 'Done']);

  // Open details dialog via card trigger button and verify populated fields, options and read-only metadata.
  const trigger = card.locator('.task-card-trigger');
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Task Details' });
  await expect(dialog).toBeVisible();

  const expectedCreator = users.find(u => u.id === target.created_by)?.name ?? 'Unknown user';
  await expect(dialog.getByLabel('Task metadata')).toContainText(`Created by: ${expectedCreator}`);
  await expect(dialog.getByLabel('Title')).toHaveValue(target.title);
  await expect(dialog.getByLabel('Description')).toHaveValue(target.description ?? '');
  await expect(dialog.getByLabel('Status')).toHaveValue(target.status);
  await expect(dialog.getByLabel('Status').locator('option')).toHaveText(['To do', 'In progress', 'Done']);
  await expect(dialog.getByLabel('Priority')).toHaveValue(target.priority);
  await expect(dialog.getByLabel('Priority').locator('option')).toHaveText(['Low', 'Medium', 'High']);
  await expect(dialog.getByLabel('Assignee')).toHaveValue(
    users.some(u => u.id === target.assigned_to) ? String(target.assigned_to) : '',
  );

  // Escape closes without writes and restores focus to the card trigger.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(attemptedMutations).toEqual([]);

  // Reopen, exercise non-destructive Delete task confirmation view and Cancel/Escape without issuing mutations.
  await trigger.click();
  await expect(dialog).toBeVisible();
  const deleteTrigger = dialog.getByRole('button', { name: 'Delete task', exact: true });
  await expect(deleteTrigger).toBeEnabled();
  await deleteTrigger.click();
  await expect(dialog.getByRole('heading', { name: 'Confirm task deletion', exact: true })).toBeVisible();
  await expect(dialog.getByText('Permanently delete this task? This cannot be undone.')).toBeVisible();
  await expect(dialog.locator('.delete-target-title')).toContainText(target.title);
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  expect(attemptedMutations).toEqual([]);

  await page.keyboard.press('Escape');
  await expect(dialog.getByRole('heading', { name: 'Confirm task deletion' })).toHaveCount(0);
  await expect(deleteTrigger).toBeFocused();
  expect(attemptedMutations).toEqual([]);

  await deleteTrigger.click();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Confirm task deletion' })).toHaveCount(0);
  await expect(deleteTrigger).toBeFocused();
  expect(attemptedMutations).toEqual([]);

  // Clear title, attempt invalid save -> verify client validation and zero mutation requests.
  await dialog.getByLabel('Title').fill('   ');
  await dialog.getByRole('button', { name: 'Save Changes', exact: true }).click();
  await expect(dialog.getByText('Title is required.')).toBeVisible();
  await expect(dialog.getByLabel('Title')).toHaveAttribute('aria-invalid', 'true');
  expect(attemptedMutations).toEqual([]);

  // Cancel discards browser-local edits and leaves the card unchanged.
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(card.getByRole('heading')).toHaveText(target.title);
  expect(attemptedMutations).toEqual([]);
});

test('non-destructive task filtering controls, progressive narrowing and Clear Filters work on deployed board', async ({ page, request }) => {
  const users = await getUsers(request);
  expect(users.length).toBeGreaterThan(0);

  const attemptedMutations: string[] = [];
  let taskGetCount = 0;
  await page.route('**/api/tasks*', async route => {
    if (route.request().method() !== 'GET') {
      attemptedMutations.push(`${route.request().method()} ${route.request().url()}`);
      await route.abort();
      return;
    }
    if (route.request().url().endsWith('/api/tasks')) {
      taskGetCount++;
    }
    await route.continue();
  });

  const loaded = page.waitForResponse(r => r.url().endsWith('/api/tasks') && r.request().method() === 'GET');
  await page.goto('/');
  const liveTasks = assertTasks(await (await loaded).json());
  await expectBoard(page, liveTasks, users);
  const initialGetCount = taskGetCount;
  for (const viewport of [{ width: 1280, height: 800 }, { width: 375, height: 667 }]) {
    await page.setViewportSize(viewport);
    await expectDashboardSummary(page, liveTasks);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
  }

  const filterGroup = page.getByRole('group', { name: 'Task filters' });
  await expect(filterGroup).toBeVisible();
  const assigneeSelect = filterGroup.getByLabel('Assignee');
  const statusSelect = filterGroup.getByLabel('Status');
  const prioritySelect = filterGroup.getByLabel('Priority');
  const clearButton = filterGroup.getByRole('button', { name: 'Clear Filters', exact: true });

  await expect(assigneeSelect).toBeVisible();
  await expect(statusSelect).toBeVisible();
  await expect(prioritySelect).toBeVisible();
  await expect(clearButton).toBeVisible();
  await expect(clearButton).toBeDisabled();

  await expect(assigneeSelect).toHaveValue('');
  await expect(assigneeSelect.locator('option')).toHaveText(['All Users', ...users.map(u => u.name)]);
  await expect(statusSelect).toHaveValue('');
  await expect(statusSelect.locator('option')).toHaveText(['All Statuses', 'To Do', 'In Progress', 'Done']);
  await expect(prioritySelect).toHaveValue('');
  await expect(prioritySelect.locator('option')).toHaveText(['All Priorities', 'Low', 'Medium', 'High']);

  // Choose filter values dynamically from existing tasks if available, or fall back to standard enum values on an empty board.
  const sampleTask = liveTasks[0];
  const chosenStatus = sampleTask?.status ?? 'in_progress';
  const chosenPriority = sampleTask?.priority ?? 'high';
  const chosenAssignee = String(sampleTask?.assigned_to ?? users[0].id);

  // 1. Filter by status.
  await statusSelect.selectOption(chosenStatus);
  await expect(clearButton).toBeEnabled();
  await expectBoard(
    page,
    liveTasks.filter(t => t.status === chosenStatus),
    users,
    { filtered: true },
  );

  await expectDashboardSummary(page, liveTasks);

  // 2. Further narrow by priority.
  await prioritySelect.selectOption(chosenPriority);
  await expectBoard(
    page,
    liveTasks.filter(t => t.status === chosenStatus && t.priority === chosenPriority),
    users,
    { filtered: true },
  );

  await expectDashboardSummary(page, liveTasks);

  // 3. Further narrow by assignee.
  await assigneeSelect.selectOption(chosenAssignee);
  await expectBoard(
    page,
    liveTasks.filter(
      t => t.status === chosenStatus && t.priority === chosenPriority && t.assigned_to === Number(chosenAssignee),
    ),
    users,
    { filtered: true },
  );

  await expectDashboardSummary(page, liveTasks);

  // 4. Clear Filters restores unfiltered board and column counts without extra network calls.
  await clearButton.click();
  await expect(assigneeSelect).toHaveValue('');
  await expect(statusSelect).toHaveValue('');
  await expect(prioritySelect).toHaveValue('');
  await expect(clearButton).toBeDisabled();
  await expectBoard(page, liveTasks, users);

  expect(taskGetCount).toBe(initialGetCount);
  expect(attemptedMutations).toEqual([]);
});
