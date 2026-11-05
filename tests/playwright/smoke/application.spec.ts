import { test, expect } from '@playwright/test';

test('deployed application is reachable and renders RecoverBoard', async ({ page }) => {
  const response = await page.goto('/');
  expect(response?.ok()).toBeTruthy();
  await expect(page.getByRole('heading', { name: 'RecoverBoard', exact: true })).toBeVisible();
  await expect(page.getByLabel('Current user')).toBeVisible();
});
