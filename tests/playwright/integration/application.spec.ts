import { test, expect } from '@playwright/test';

test('application loads without fatal browser errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const response = await page.goto('/');
  expect(response?.ok()).toBeTruthy();
  await expect(page.getByRole('heading', { name: 'RecoverBoard', exact: true })).toBeVisible();
  await expect(page.getByLabel('Current user')).toBeVisible();
  expect(errors).toEqual([]);
});
