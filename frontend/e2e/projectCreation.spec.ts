import { expect, test } from '@playwright/test';
import { LIVE_API, installApiMocks } from './fixtures/api';

/**
 * Project creation.
 *
 * There is no create form in the interface yet. The API accepts a project and
 * the registry reads one back, so the journey is tested through the API against
 * a live stack, and the parts of the journey that do exist in the interface are
 * tested with mocks.
 *
 * The API-backed cases run only with `E2E_LIVE_API` set. They are written now so
 * that adding the form is a matter of pointing them at it rather than writing
 * the coverage from scratch.
 */
test.describe('project registry', () => {
  test('reaches the registry from the navigation', async ({ page }) => {
    await installApiMocks(page);
    await page.goto('/');
    await page.getByRole('link', { name: /Project registry/ }).click();
    await expect(page).toHaveURL(/\/projects$/);
    await expect(page.getByRole('heading', { name: 'Project registry' })).toBeVisible();
  });

  test('refuses the registry to a role without project access', async ({ page }) => {
    await installApiMocks(page, {
      role: 'VIEWER',
      overrides: [
        {
          pattern: '**/api/v1/auth/me',
          handler: (route) =>
            route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                user: { id: 'u', email: 'v@test.gov', role: 'VIEWER', stateCode: 'Punjab', districtCode: null, department: null },
                scope: { level: 'STATE', stateCode: 'Punjab', districtCode: null, department: null, basis: 'test' },
                permissions: ['analytics:read'],
              }),
            }),
        },
      ],
    });
    await page.goto('/projects');
    await expect(page.getByText('You do not have access to this page')).toBeVisible();
    await expect(page.getByText(/projects:read/)).toBeVisible();
  });
});

test.describe('project creation through the API', () => {
  test.skip(!LIVE_API, 'set E2E_LIVE_API and seed a backend to run the creation journey');

  const credentials = {
    email: process.env.E2E_EMAIL ?? 'district.officer@test.gov',
    password: process.env.E2E_PASSWORD ?? 'Ludhiana7Ring9Road',
  };

  const uniqueCode = () => `PB-LDH-E2E-${Date.now().toString().slice(-6)}`;

  test('creates a project, then reads it back from the registry', async ({ request }) => {
    const login = await request.post(`${LIVE_API}/api/v1/auth/login`, { data: credentials });
    expect(login.ok()).toBeTruthy();
    const { token } = await login.json();

    const projectCode = uniqueCode();
    const created = await request.post(`${LIVE_API}/api/v1/projects`, {
      headers: { authorization: `Bearer ${token}` },
      data: {
        projectCode,
        name: 'End-to-end corridor acquisition',
        state: 'Punjab',
        district: 'Ludhiana',
        department: 'Public Works Department',
        projectType: 'HIGHWAY',
        plannedStartDate: '2026-02-01',
        targetDate: '2026-11-01',
      },
    });
    expect(created.status()).toBe(201);
    const project = await created.json();
    expect(project.projectCode).toBe(projectCode);

    const listed = await request.get(`${LIVE_API}/api/v1/projects?search=${projectCode}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const page = await listed.json();
    expect(page.items.map((item: { projectCode: string }) => item.projectCode)).toContain(projectCode);
  });

  test('refuses a project whose target date precedes its start date', async ({ request }) => {
    const login = await request.post(`${LIVE_API}/api/v1/auth/login`, { data: credentials });
    const { token } = await login.json();

    const response = await request.post(`${LIVE_API}/api/v1/projects`, {
      headers: { authorization: `Bearer ${token}` },
      data: {
        projectCode: uniqueCode(),
        name: 'Conflicting dates',
        state: 'Punjab',
        district: 'Ludhiana',
        department: 'Public Works Department',
        projectType: 'HIGHWAY',
        plannedStartDate: '2026-11-01',
        targetDate: '2026-02-01',
      },
    });
    expect(response.status()).toBe(400);
  });

  test('refuses a project placed outside the caller district', async ({ request }) => {
    const login = await request.post(`${LIVE_API}/api/v1/auth/login`, { data: credentials });
    const { token } = await login.json();

    const response = await request.post(`${LIVE_API}/api/v1/projects`, {
      headers: { authorization: `Bearer ${token}` },
      data: {
        projectCode: uniqueCode(),
        name: 'Out of scope',
        state: 'Punjab',
        district: 'Amritsar',
        department: 'Public Works Department',
        projectType: 'HIGHWAY',
        plannedStartDate: '2026-02-01',
        targetDate: '2026-11-01',
      },
    });
    expect(response.status()).toBe(403);
  });

  test('refuses a duplicate project code', async ({ request }) => {
    const login = await request.post(`${LIVE_API}/api/v1/auth/login`, { data: credentials });
    const { token } = await login.json();

    const projectCode = uniqueCode();
    const body = {
      projectCode,
      name: 'Duplicate check',
      state: 'Punjab',
      district: 'Ludhiana',
      department: 'Public Works Department',
      projectType: 'HIGHWAY',
      plannedStartDate: '2026-02-01',
      targetDate: '2026-11-01',
    };
    const first = await request.post(`${LIVE_API}/api/v1/projects`, {
      headers: { authorization: `Bearer ${token}` },
      data: body,
    });
    expect(first.status()).toBe(201);

    const second = await request.post(`${LIVE_API}/api/v1/projects`, {
      headers: { authorization: `Bearer ${token}` },
      data: body,
    });
    expect(second.status()).toBeGreaterThanOrEqual(400);
  });
});
