import { defineConfig, devices } from '@playwright/test';

const smoke = process.env.PW_SUITE === 'smoke';
const artifacts = process.env.PW_ARTIFACTS_DIR ?? '/artifacts';
const baseURL = smoke ? process.env.BASE_URL : (process.env.BASE_URL ?? 'http://app:8080');
if (smoke && (!baseURL || !/^https?:\/\//.test(baseURL))) {
  throw new Error('Smoke tests require BASE_URL to be a valid http:// or https:// URL.');
}

export default defineConfig({
  testDir: smoke ? './smoke' : './integration',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [['list'], ['html', { outputFolder: `${artifacts}/html`, open: 'never' }], ['junit', { outputFile: `${artifacts}/junit/results.xml` }]],
  outputDir: `${artifacts}/test-results`,
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    browserName: 'chromium',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'integration', testDir: './integration', use: { ...devices['Desktop Chrome'] } },
    { name: 'smoke', testDir: './smoke', use: { ...devices['Desktop Chrome'] } },
  ],
});
