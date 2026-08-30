import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end configuration.
 *
 * `npm run dev` starts both halves of the product - the Vinext web app on 3000
 * and the WebSocket authority on 3001 - so these specs exercise the real
 * transport rather than a mock. The suite is deliberately serial: every spec
 * opens two browser contexts against one shared realtime server, and running
 * them in parallel would have independent matches competing for room codes and
 * for the server's per-socket rate limits.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
