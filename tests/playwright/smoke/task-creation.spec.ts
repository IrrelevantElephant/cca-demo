import { expect, test } from '@playwright/test';
import { getUsers } from '../helpers/api';

test('non-destructive task creation dialog defaults, validation and fail-closed write guard', async ({ page, request }) => {
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

  await page.goto('/');
  const currentUserSelect = page.getByLabel('Current user');
  const firstUser = users[0];
  await currentUserSelect.selectOption(String(firstUser.id));

  await page.getByRole('button', { name: 'Create Task', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create Task' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.creating-as')).toHaveText(`Creating as ${firstUser.name}`);

  // Verify fields, options, and defaults.
  await expect(dialog.getByLabel('Title')).toHaveValue('');
  await expect(dialog.getByLabel('Description')).toHaveValue('');
  await expect(dialog.getByLabel('Priority')).toHaveValue('medium');
  await expect(dialog.getByLabel('Priority').locator('option')).toHaveText(['Low', 'Medium', 'High']);
  await expect(dialog.getByLabel('Assignee')).toHaveValue(String(firstUser.id));
  await expect(dialog.getByLabel('Assignee').locator('option')).toHaveText(users.map(u => u.name));

  // Ensure no status or editable creator field exists in the creation dialog.
  await expect(dialog.getByLabel(/status/i)).toHaveCount(0);
  await expect(dialog.getByLabel(/created by|creator/i)).toHaveCount(0);

  // Submit empty/invalid form only; verify visible validation feedback and zero POST requests.
  await dialog.getByRole('button', { name: 'Create Task', exact: true }).click();
  await expect(dialog.getByText('Title is required.')).toBeVisible();
  await expect(dialog.getByLabel('Title')).toHaveAttribute('aria-invalid', 'true');
  expect(attemptedMutations).toEqual([]);

  // Cancel and verify selected-user change updates dialog defaults on reopen.
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);

  const lastUser = users[users.length - 1];
  await currentUserSelect.selectOption(String(lastUser.id));
  await page.getByRole('button', { name: 'Create Task', exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.creating-as')).toHaveText(`Creating as ${lastUser.name}`);
  await expect(dialog.getByLabel('Assignee')).toHaveValue(String(lastUser.id));
  await expect(dialog.getByLabel('Priority')).toHaveValue('medium');

  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(attemptedMutations).toEqual([]);
});
