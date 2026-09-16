import { expect, test } from '@playwright/test';
import { LIVE_API, installApiMocks, notificationCentre, session } from './fixtures/api';

/**
 * Session and access.
 *
 * There is no sign-in form yet; the app establishes a session from the API's
 * own session endpoint and falls back to a clearly-labelled demo session when
 * that is unreachable. These tests cover that behaviour and the role-driven
 * access control that depends on it. When a form is added, the credential cases
 * belong here alongside them.
 */
test.describe('session', () => {
  test('adopts the role and scope the API reports', async ({ page }) => {
    await installApiMocks(page, { role: 'DISTRICT_OFFICER' });
    await page.goto('/access');

    await expect(page.getByText('District officer').first()).toBeVisible();
    await expect(page.getByText('Server session').first()).toBeVisible();
    await expect(page.getByText('Ludhiana').first()).toBeVisible();
  });

  test('falls back to a labelled demo session when the API is unreachable', async ({ page }) => {
    test.skip(Boolean(LIVE_API), 'the fallback only applies without a backend');
    // Every API call fails, which is what an unreachable backend looks like.
    await page.route('**/api/v1/**', (route) => route.abort('failed'));
    await page.goto('/access');

    await expect(page.getByText('Demo session').first()).toBeVisible();
    // The switcher only appears when the session is simulated, so the state is
    // never ambiguous to whoever is looking at the screen.
    await expect(page.getByRole('button', { name: 'Analyst' })).toBeVisible();
  });

  test('shows a viewer only the navigation their role carries', async ({ page }) => {
    await installApiMocks(page, { role: 'VIEWER' });
    await page.goto('/');

    await expect(page.getByRole('link', { name: /Overview/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Project registry/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Intervention queue/ })).toBeVisible();
  });

  test('refuses a page the role cannot use, naming the missing permission', async ({ page }) => {
    await installApiMocks(page, {
      role: 'VIEWER',
      overrides: [
        {
          pattern: '**/api/v1/auth/me',
          handler: (route) => {
            const body = session('VIEWER');
            // A viewer without analytics access cannot open the dashboard.
            body.permissions = body.permissions.filter((permission) => permission !== 'analytics:read');
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
          },
        },
      ],
    });
    await page.goto('/');

    await expect(page.getByText('You do not have access to this page')).toBeVisible();
    await expect(page.getByText(/analytics:read/)).toBeVisible();
  });

  test('keeps the guard when the URL is typed directly', async ({ page }) => {
    await installApiMocks(page, {
      role: 'VIEWER',
      overrides: [
        {
          pattern: '**/api/v1/auth/me',
          handler: (route) => {
            const body = session('VIEWER');
            body.permissions = body.permissions.filter((permission) => permission !== 'alerts:read');
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
          },
        },
      ],
    });
    await page.goto('/alerts');
    await expect(page.getByText('You do not have access to this page')).toBeVisible();
  });

  test('shows the role and scope in the shell, so the session is never in doubt', async ({ page }) => {
    await installApiMocks(page, { role: 'PROJECT_OFFICER' });
    await page.goto('/');
    await expect(page.getByText('Project officer').first()).toBeVisible();
    await expect(page.getByText('Public Works Department').first()).toBeVisible();
  });

  test('carries the unacknowledged count into the sidebar badge', async ({ page }) => {
    await installApiMocks(page);
    await page.goto('/');
    const badge = page.locator('.nav-count');
    await expect(badge).toHaveText(String(notificationCentre().counts.unacknowledged));
  });
});
