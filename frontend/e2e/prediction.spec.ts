import { expect, test } from '@playwright/test';
import { installApiMocks } from './fixtures/api';

/**
 * Prediction and explanation.
 *
 * The prediction is the reason this platform exists, and the governance rules
 * around it are strict: an officer must see the probability, the factors behind
 * it, and a statement that those factors are associations. These tests check all
 * three travel together, and that no causal claim reaches the screen.
 */
test.describe('prediction', () => {
  test.beforeEach(async ({ page }) => {
    await installApiMocks(page);
    await page.goto('/');
    await page.locator('tbody tr').first().click();
    await expect(page.locator('.detail-drawer')).toBeVisible();
  });

  test('shows the probability, the expected delay, and the risk category together', async ({ page }) => {
    const kpis = page.locator('.detail-kpis');
    await expect(kpis).toBeVisible();
    await expect(kpis.getByText('Delay probability')).toBeVisible();
    await expect(kpis.getByText('Expected delay')).toBeVisible();
    await expect(kpis.getByText('Risk category')).toBeVisible();
  });

  test('reports the probability as a percentage inside the possible range', async ({ page }) => {
    const value = await page.locator('.detail-kpis strong').first().innerText();
    expect(value).toMatch(/^\d{1,3}%$/);
    const percentage = Number(value.replace('%', ''));
    expect(percentage).toBeGreaterThanOrEqual(0);
    expect(percentage).toBeLessThanOrEqual(100);
  });

  test('explains why the project is at risk, with ranked factors', async ({ page }) => {
    await expect(page.getByText('Why is this project at risk?')).toBeVisible();
    const factors = page.locator('.factor');
    expect(await factors.count()).toBeGreaterThan(1);
  });

  test('states the association disclaimer next to the factors', async ({ page }) => {
    await expect(page.getByText(/associated with higher predicted delay risk/i)).toBeVisible();
    await expect(page.getByText(/not causal findings/i)).toBeVisible();
  });

  test('makes no causal or guaranteed claim anywhere in the drawer', async ({ page }) => {
    const text = await page.locator('.detail-drawer').innerText();
    // Affirmative claims only. The drawer does say "not a guaranteed schedule
    // outcome", which is the disclaimer working rather than a claim.
    for (const forbidden of [
      /\bcaused\b/i,
      /\bwill (reduce|prevent|fix|resolve)\b/i,
      /\bis guaranteed\b/i,
      /\bensures\b/i,
      /\beliminates\b/i,
    ]) {
      expect(text).not.toMatch(forbidden);
    }
    expect(text).toMatch(/not a guaranteed schedule outcome/i);
  });

  test('recommends actions with a responsible owner and a hedged impact', async ({ page }) => {
    await expect(page.getByText('What should the officer do?')).toBeVisible();
    const actions = page.locator('.action-item');
    expect(await actions.count()).toBeGreaterThan(0);

    const first = actions.first();
    await expect(first.getByText('Responsible')).toBeVisible();
    await expect(first.getByText('Suggested deadline')).toBeVisible();
    await expect(first.getByText('Expected impact')).toBeVisible();
    await expect(first).toContainText(/may |could /i);
  });

  test('shows a priority and a deadline on every recommended action', async ({ page }) => {
    const actions = page.locator('.action-item');
    const count = await actions.count();
    for (let index = 0; index < count; index += 1) {
      await expect(actions.nth(index).locator('.action-priority')).toContainText(/PRIORITY/);
      await expect(actions.nth(index)).toContainText(/\d+ days/);
    }
  });

  test('assigns an action and confirms it to the officer', async ({ page }) => {
    await page.locator('.action-item').first().getByRole('button', { name: 'Assign' }).click();
    await expect(page.locator('.toast')).toBeVisible();
  });

  test('shows the acquisition timeline alongside the prediction', async ({ page }) => {
    await expect(page.getByText('Acquisition timeline')).toBeVisible();
    expect(await page.locator('.stage').count()).toBeGreaterThan(1);
  });
});
