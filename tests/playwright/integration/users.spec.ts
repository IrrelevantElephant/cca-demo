import { test, expect } from '@playwright/test';
import { getUsers } from '../helpers/api';

test('API supplies exactly the three seeded users and expected roles', async ({ request }) => {
  const users = await getUsers(request);
  expect(users).toHaveLength(3);
  expect(users.every(user => Number.isInteger(user.id) && !!user.name && !!user.role)).toBeTruthy();
  expect(new Set(users.map(user => user.id)).size).toBe(3);
  expect(users.map(({ name, role }) => [name, role])).toEqual([
    ['Alice', 'Developer'], ['Bob', 'Developer'], ['Charlie', 'Team Lead'],
  ]);
});

test('loaded selector shows each role and defaults to Alice', async ({ page }) => {
  const response = page.waitForResponse(response => response.url().endsWith('/api/users') && response.status() === 200);
  await page.goto('/');
  await response;
  const selector = page.getByLabel('Current user');
  await expect(selector).toHaveValue('1');
  await expect(selector.locator('option')).toHaveText([
    'Alice · Developer', 'Bob · Developer', 'Charlie · Team Lead',
  ]);
});
