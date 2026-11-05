import { test, expect } from '@playwright/test';

test('switches active users and persists selection after refresh', async ({ page }) => {
  await page.goto('/');
  const selector = page.getByLabel('Current user');
  await expect(selector).toHaveValue('1');
  for (const [id, name] of [['2', 'Bob'], ['3', 'Charlie']] as const) {
    await selector.selectOption(id);
    await expect(page.locator('.current-user strong')).toHaveText(name);
  }
});

test('restores Bob after reload and rejects an invalid saved identity', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Current user').selectOption('2');
  await page.reload();
  await expect(page.getByLabel('Current user')).toHaveValue('2');
  await expect(page.locator('.current-user strong')).toHaveText('Bob');

  await page.evaluate(() => localStorage.setItem('recoverboard.selectedUserId', '99999'));
  await page.reload();
  await expect(page.getByLabel('Current user')).toHaveValue('1');
  await expect(page.locator('.current-user strong')).toHaveText('Alice');
});

test('refreshes repeatedly and isolates selections in separate contexts', async ({ browser }) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  try {
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    await Promise.all([alice.goto('/'), bob.goto('/')]);
    await alice.getByLabel('Current user').selectOption('1');
    await bob.getByLabel('Current user').selectOption('2');
    await alice.reload();
    await bob.reload();
    await expect(alice.locator('.current-user strong')).toHaveText('Alice');
    await expect(bob.locator('.current-user strong')).toHaveText('Bob');
    await alice.reload();
    await expect(alice.getByLabel('Current user')).toHaveValue('1');
  } finally {
    await aliceContext.close();
    await bobContext.close();
  }
});
