import { expect, test } from '@playwright/test';
import { installApiMocks } from './fixtures/api';

/**
 * Executive dashboard.
 *
 * The dashboard is the first screen an officer sees, so these tests check that
 * the summary, the charts, and the project table all render together, and that
 * the association disclaimer travels with the risk figures.
 */
test.describe('dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await installApiMocks(page);
    await page.goto('/');
  });

  test('renders the summary tiles', async ({ page }) => {
    await expect(page.locator('.stat-card').first()).toBeVisible();
    const tiles = await page.locator('.stat-card').count();
    expect(tiles).toBeGreaterThan(2);
  });

  test('renders the project table with rows an officer can open', async ({ page }) => {
    const rows = page.locator('tbody tr');
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeGreaterThan(0);
    await expect(page.getByRole('columnheader', { name: /Delay probability/ })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /Risk/ }).first()).toBeVisible();
  });

  test('shows a delay probability as a percentage, not a raw score', async ({ page }) => {
    const cell = page.locator('tbody tr').first().locator('td').nth(4);
    await expect(cell).toHaveText(/^\d{1,3}%$/);
  });

  test('renders the risk and trend charts', async ({ page }) => {
    await expect(page.locator('.panel').first()).toBeVisible();
    await expect(page.locator('svg').first()).toBeVisible();
  });

  test('opens a project drawer from a table row and closes it again', async ({ page }) => {
    await page.locator('tbody tr').first().click();
    const drawer = page.locator('.detail-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText('PROJECT DETAIL')).toBeVisible();

    await page.getByRole('button', { name: 'Close detail' }).click();
    await expect(drawer).toBeHidden();
  });

  test('states that risk factors are associations rather than causes', async ({ page }) => {
    await page.locator('tbody tr').first().click();
    await expect(page.getByText(/not causal findings/i)).toBeVisible();
  });

  test('is usable at a narrow viewport', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await expect(page.locator('.stat-card').first()).toBeVisible();
    // No horizontal overflow of the document itself.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
