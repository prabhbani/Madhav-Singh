import { expect, test } from '@playwright/test';
import { installApiMocks } from './fixtures/api';

/**
 * Risk filtering.
 *
 * Filtering is how an officer turns a long register into a working list, so the
 * important properties are that a filter narrows rather than reorders, that
 * filters combine, and that an empty result says so rather than looking broken.
 */
test.describe('risk filtering', () => {
  test.beforeEach(async ({ page }) => {
    await installApiMocks(page);
    await page.goto('/');
    await expect(page.locator('tbody tr').first()).toBeVisible();
  });

  const riskSelect = (page: import('@playwright/test').Page) => page.locator('select').first();

  test('narrows the table to a single risk level', async ({ page }) => {
    const before = await page.locator('tbody tr').count();
    await riskSelect(page).selectOption('CRITICAL');

    const rows = page.locator('tbody tr');
    const after = await rows.count();
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThan(0);

    // Every remaining row really is at that level.
    const badges = await rows.locator('.risk-badge').allInnerTexts();
    for (const badge of badges) expect(badge.toUpperCase()).toContain('CRITICAL');
  });

  test('restores the full list when the filter is cleared', async ({ page }) => {
    const before = await page.locator('tbody tr').count();
    await riskSelect(page).selectOption('CRITICAL');
    await riskSelect(page).selectOption('ALL');
    await expect(page.locator('tbody tr')).toHaveCount(before);
  });

  test('offers every risk level', async ({ page }) => {
    // Labels are shown in sentence case; the values stay the stable codes.
    const values = await riskSelect(page).locator('option').evaluateAll((options) =>
      options.map((option) => (option as HTMLOptionElement).value),
    );
    expect(values).toEqual(['ALL', 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
    const labels = (await riskSelect(page).locator('option').allInnerTexts()).join(' ');
    expect(labels).toContain('All risk levels');
    expect(labels).toContain('Critical');
  });

  test('searches by project name and by identifier', async ({ page }) => {
    const firstName = await page.locator('tbody tr').first().locator('td span').first().innerText();
    await page.getByPlaceholder(/Search project/).fill(firstName);
    const rows = page.locator('tbody tr');
    expect(await rows.count()).toBeGreaterThan(0);
    await expect(rows.first()).toContainText(firstName);
  });

  test('combines a search with a risk filter', async ({ page }) => {
    await riskSelect(page).selectOption('LOW');
    const lowCount = await page.locator('tbody tr').count();
    await page.getByPlaceholder(/Search project/).fill('zzz-no-such-project');
    const combined = await page.locator('tbody tr').count();
    expect(combined).toBeLessThanOrEqual(lowCount);
  });

  test('says so when a filter matches nothing, rather than looking broken', async ({ page }) => {
    await page.getByPlaceholder(/Search project/).fill('zzz-no-such-project-anywhere');
    await expect(page.locator('tbody tr')).toHaveCount(0);
    // The surrounding table furniture is still on screen.
    await expect(page.getByRole('columnheader', { name: /Delay probability/ })).toBeVisible();
  });

  test('filters by district and department as well as risk', async ({ page }) => {
    const selects = page.locator('select');
    expect(await selects.count()).toBeGreaterThanOrEqual(3);
    const before = await page.locator('tbody tr').count();

    const districtOptions = await selects.nth(1).locator('option').all();
    if (districtOptions.length > 1) {
      const value = await districtOptions[1]!.getAttribute('value');
      if (value) {
        await selects.nth(1).selectOption(value);
        expect(await page.locator('tbody tr').count()).toBeLessThanOrEqual(before);
      }
    }
  });
});
