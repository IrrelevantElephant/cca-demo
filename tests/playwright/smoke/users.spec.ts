import { test, expect } from '@playwright/test';
import { getUsers } from '../helpers/api';

test('deployed users API and selection journey work', async ({ request, page }) => {
  const users = await getUsers(request);
  expect(users.length).toBeGreaterThan(0);
  expect(users.every(user => Number.isInteger(user.id) && typeof user.name === 'string' && typeof user.role === 'string')).toBeTruthy();
  await page.goto('/');
  const selector = page.getByLabel('Current user');
  await expect(selector.locator('option')).toHaveCount(users.length);
  const choice = users.at(-1)!;
  await selector.selectOption(String(choice.id));
  await expect(page.locator('.current-user strong')).toHaveText(choice.name);
  await page.reload();
  await expect(selector).toHaveValue(String(choice.id));
  await expect(page.locator('.current-user strong')).toHaveText(choice.name);
});
