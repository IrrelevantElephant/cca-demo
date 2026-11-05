import { expect, type Page } from '@playwright/test';
import type { ApiTask } from './api';

export async function expectDashboardSummary(page: Page, allTasks: ApiTask[]) {
  const summary = page.getByRole('region', { name: 'Dashboard summary', exact: true });
  await expect(summary).toBeVisible();
  for (const [id, label, count] of [
    ['total', 'Total Tasks', allTasks.length],
    ['todo', 'To Do', allTasks.filter(t => t.status === 'todo').length],
    ['in-progress', 'In Progress', allTasks.filter(t => t.status === 'in_progress').length],
    ['completed', 'Completed', allTasks.filter(t => t.status === 'done').length],
  ] as const) {
    await expect(summary.getByText(label, { exact: true })).toBeVisible();
    await expect(summary.getByTestId(`summary-${id}`)).toHaveText(String(count));
  }
}

export async function expectBoard(
  page: Page,
  tasks: ApiTask[],
  users: Array<{ id: number; name: string }>,
  options?: { filtered?: boolean },
) {
  const isFiltered = options?.filtered ?? false;
  if (!isFiltered) await expectDashboardSummary(page, tasks);
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  for (const [status, label] of [['todo', 'To do'], ['in_progress', 'In progress'], ['done', 'Done']]) {
    const subset = tasks.filter(task => task.status === status);
    const column = page.getByRole('region', { name: `${label} (${subset.length})`, exact: true });
    await expect(column).toBeVisible();
    await expect(column.locator('.task-card')).toHaveCount(subset.length);
    expect(await column.locator('.task-card').evaluateAll(cards => cards.map(card => Number(card.getAttribute('data-task-id'))))).toEqual(subset.map(task => task.id));
    for (const task of subset) {
      const card = column.locator(`[data-task-id="${task.id}"]`);
      await expect(card.getByRole('heading')).toHaveText(task.title);
      await expect(card).toContainText(`Priority: ${task.priority}`);
      await expect(card).toContainText(`Assigned to: ${users.find(user => user.id === task.assigned_to)?.name ?? 'Unknown user'}`);
      await expect(card.getByLabel('Status')).toHaveValue(task.status);
      if (task.description) await expect(card.locator('.task-description')).toHaveText(task.description);
      else await expect(card.locator('.task-description')).toHaveCount(0);
    }
    if (!subset.length) {
      await expect(
        column.getByText(isFiltered ? 'No matching tasks in this column.' : 'No tasks in this column.', { exact: true }),
      ).toBeVisible();
    }
  }
  if (isFiltered) {
    await expect(page.getByText('No tasks match the selected filters.', { exact: true })).toHaveCount(tasks.length ? 0 : 1);
    await expect(page.getByText('No tasks yet', { exact: true })).toHaveCount(0);
  } else {
    await expect(page.getByText('No tasks yet', { exact: true })).toHaveCount(tasks.length ? 0 : 1);
    await expect(page.getByText('No tasks match the selected filters.', { exact: true })).toHaveCount(0);
  }
}
