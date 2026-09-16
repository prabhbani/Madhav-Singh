import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end configuration.
 *
 * The suite runs against the built frontend with the API mocked at the network
 * boundary, so it needs no database, no backend, and no seeded data. That keeps
 * it runnable in a pull request rather than only in a full environment.
 *
 * Set `E2E_LIVE_API` to point at a running backend to exercise the real stack
 * instead; the mocks stand aside when it is present.
 */
const PORT = Number(process.env.E2E_PORT ?? 4173);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // The preview server serves the production build, so the content security
    // policy injected at build time is exercised too.
    // The build needs an API base, or the client short-circuits to its demo
    // data and the route mocks are never reached. Pointing it at the preview
    // origin lets Playwright intercept, or at a real backend when one is given.
    // `--host 127.0.0.1` matters too: without it Vite binds IPv6 localhost
    // only, and the browser's IPv4 baseURL is refused.
    command:
      `VITE_API_URL=${process.env.E2E_LIVE_API ?? `http://127.0.0.1:${PORT}`} npm run build` +
      ` && npm run preview -- --port ${PORT} --strictPort --host 127.0.0.1`,
    port: PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
