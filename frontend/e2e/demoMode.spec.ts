import { expect, test, type Page } from '@playwright/test';
import { alertFor, installApiMocks } from './fixtures/api';

/**
 * Demo mode.
 *
 * The guided tour is what a judge sees, so it is worth testing as carefully as
 * anything else: that every step finds its target, that the spotlight actually
 * moves, that the drawer opens when a step needs it, and above all that the
 * synthetic-data warning is on screen the entire time.
 */

const TOTAL_STEPS = 12;

const startTour = async (page: Page) => {
  await page.locator('[data-demo="start-tour-primary"]').click();
  await expect(page.locator('[data-demo-card]')).toBeVisible();
};

test.describe('demo mode indicator', () => {
  test.beforeEach(async ({ page }) => {
    await installApiMocks(page, { alerts: [alertFor()] });
    await page.goto('/');
  });

  test('shows a demo banner on every screen', async ({ page }) => {
    const banner = page.locator('[data-demo="demo-banner"]');
    for (const route of ['/', '/projects', '/alerts', '/analytics', '/access']) {
      await page.goto(route);
      await expect(banner).toBeVisible();
      await expect(banner).toContainText('DEMO MODE');
    }
  });

  test('states plainly that the data is not real government records', async ({ page }) => {
    const banner = page.locator('[data-demo="demo-banner"]');
    await expect(banner).toContainText(/synthetic/i);
    await expect(banner).toContainText(/not live government records/i);
    await expect(banner).toContainText(/no real landowner, compensation, or case information/i);
  });

  test('keeps the banner visible while the tour runs', async ({ page }) => {
    await startTour(page);
    await expect(page.locator('[data-demo="demo-banner"]')).toBeVisible();
    await expect(page.locator('[data-demo-card]')).toContainText('SYNTHETIC DEMO DATA');
  });

  test('offers the tour from the banner as well as the invitation', async ({ page }) => {
    await page.locator('[data-demo="demo-invitation"] .demo-icon-button').click();
    await expect(page.locator('[data-demo="demo-invitation"]')).toBeHidden();
    await page.locator('[data-demo="start-tour"]').click();
    await expect(page.locator('[data-demo-card]')).toBeVisible();
  });
});

test.describe('guided tour invitation', () => {
  test.beforeEach(async ({ page }) => {
    await installApiMocks(page);
    await page.goto('/');
  });

  test('tells a judge how long it takes and what it covers', async ({ page }) => {
    const invitation = page.locator('[data-demo="demo-invitation"]');
    await expect(invitation).toBeVisible();
    await expect(invitation).toContainText(/2 min/);
    await expect(invitation.locator('.demo-outline li')).toHaveCount(TOTAL_STEPS);
  });

  test('can be dismissed by someone who would rather explore', async ({ page }) => {
    await page.getByRole('button', { name: 'Explore on my own' }).click();
    await expect(page.locator('[data-demo="demo-invitation"]')).toBeHidden();
  });

  test('promises that nothing on screen is a hardcoded number', async ({ page }) => {
    await expect(page.locator('[data-demo="demo-invitation"]')).toContainText(/computed from the demonstration database/i);
  });
});

test.describe('the twelve steps', () => {
  test.beforeEach(async ({ page }) => {
    await installApiMocks(page, { alerts: [alertFor()] });
    await page.goto('/');
    await startTour(page);
  });

  test('opens on step one, with autoplay running', async ({ page }) => {
    const card = page.locator('[data-demo-card]');
    await expect(card).toContainText(`STEP 01 / ${TOTAL_STEPS}`);
    await expect(card).toContainText('Executive dashboard');
    await expect(page.locator('.demo-spotlight')).toBeVisible();
  });

  test('walks all twelve steps, finding a target on every one', async ({ page }) => {
    const card = page.locator('[data-demo-card]');
    const titles: string[] = [];

    for (let step = 1; step <= TOTAL_STEPS; step += 1) {
      await expect(card).toContainText(`STEP ${String(step).padStart(2, '0')} / ${TOTAL_STEPS}`);
      // Every step must spotlight something. A missing target is the failure
      // this test exists to catch, because it only shows up at the podium.
      await expect(page.locator('.demo-spotlight')).toBeVisible({ timeout: 8_000 });
      titles.push((await card.locator('h2').innerText()).trim());
      if (step < TOTAL_STEPS) await page.getByRole('button', { name: 'Next step' }).click();
    }

    assertUniqueTitles(titles);
    await expect(page.getByRole('button', { name: 'Finish' })).toBeVisible();
  });

  test('covers the twelve subjects the brief asked for, in order', async ({ page }) => {
    const expected = [
      /executive dashboard/i,
      /active acquisition projects/i,
      /high risk/i,
      /critical case/i,
      /delay probability/i,
      /expected delay/i,
      /why the system/i,
      /risk factors/i,
      /preventive actions/i,
      /early warning alert/i,
      /acknowledgement/i,
      /department and district/i,
    ];
    const card = page.locator('[data-demo-card]');
    for (const [index, pattern] of expected.entries()) {
      await expect(card.locator('h2')).toHaveText(pattern);
      if (index < expected.length - 1) await page.getByRole('button', { name: 'Next step' }).click();
    }
  });

  test('moves the spotlight between steps rather than leaving it parked', async ({ page }) => {
    const spotlight = page.locator('.demo-spotlight');
    const first = await spotlight.boundingBox();
    await page.getByRole('button', { name: 'Next step' }).click();
    await page.getByRole('button', { name: 'Next step' }).click();
    await expect(async () => {
      const later = await spotlight.boundingBox();
      expect(later).not.toEqual(first);
    }).toPass({ timeout: 6_000 });
  });

  test('opens the project drawer for the case-level steps', async ({ page }) => {
    for (let step = 1; step < 4; step += 1) await page.getByRole('button', { name: 'Next step' }).click();
    await expect(page.locator('[data-demo="project-detail"]')).toBeVisible();
    await expect(page.locator('[data-demo-card]')).toContainText('critical case');
  });

  test('shows the probability, the delay, the explanation, and the actions in sequence', async ({ page }) => {
    for (let step = 1; step < 5; step += 1) await page.getByRole('button', { name: 'Next step' }).click();
    await expect(page.locator('[data-demo="prediction-probability"]')).toBeVisible();

    await page.getByRole('button', { name: 'Next step' }).click();
    await expect(page.locator('[data-demo="prediction-delay"]')).toBeVisible();

    await page.getByRole('button', { name: 'Next step' }).click();
    await expect(page.locator('[data-demo="why-card"]')).toBeVisible();
    await expect(page.locator('[data-demo="why-card"]')).toContainText(/not causal findings/i);

    await page.getByRole('button', { name: 'Next step' }).click();
    await expect(page.locator('[data-demo="risk-factors"]')).toBeVisible();

    await page.getByRole('button', { name: 'Next step' }).click();
    await expect(page.locator('[data-demo="recommended-actions"]')).toBeVisible();
  });

  test('reaches the alert queue and leaves the acknowledge button clickable', async ({ page }) => {
    for (let step = 1; step < 11; step += 1) await page.getByRole('button', { name: 'Next step' }).click();
    await expect(page).toHaveURL(/\/alerts$/);
    await expect(page.locator('[data-demo-card]')).toContainText('acknowledgement');

    // The spotlight must not swallow the click, or the invitation is a lie.
    const button = page.locator('[data-demo="alert-acknowledge"]').first();
    await expect(button).toBeVisible();
    await button.click();
    await expect(page.locator('.alert-item').first().locator('.alert-ack')).toBeVisible();
  });

  test('finishes on the analytics view', async ({ page }) => {
    for (let step = 1; step < TOTAL_STEPS; step += 1) await page.getByRole('button', { name: 'Next step' }).click();
    await expect(page).toHaveURL(/\/analytics$/);
    await expect(page.locator('[data-demo="analytics-charts"]')).toBeVisible();
    await expect(page.locator('[data-demo="department-analytics"]')).toBeVisible();
    await expect(page.locator('[data-demo="district-analytics"]')).toBeVisible();
  });
});

test.describe('tour controls', () => {
  test.beforeEach(async ({ page }) => {
    await installApiMocks(page, { alerts: [alertFor()] });
    await page.goto('/');
    await startTour(page);
  });

  test('goes back as well as forward', async ({ page }) => {
    await page.getByRole('button', { name: 'Next step' }).click();
    await expect(page.locator('[data-demo-card]')).toContainText('STEP 02');
    await page.getByRole('button', { name: 'Previous step' }).click();
    await expect(page.locator('[data-demo-card]')).toContainText('STEP 01');
  });

  test('jumps to any step from the progress dots', async ({ page }) => {
    await page.getByRole('button', { name: /Go to step 10/ }).click();
    await expect(page.locator('[data-demo-card]')).toContainText('STEP 10');
  });

  test('pauses and resumes autoplay', async ({ page }) => {
    await page.getByRole('button', { name: /Pause the guided demonstration/ }).click();
    await expect(page.getByRole('button', { name: /Resume the guided demonstration/ })).toBeVisible();
  });

  test('advances on its own when autoplay is left running', async ({ page }) => {
    // Step one holds for eleven seconds, so this proves the timer works without
    // waiting for the whole tour.
    await expect(page.locator('[data-demo-card]')).toContainText('STEP 02', { timeout: 15_000 });
  });

  test('exits from the card, the banner, and the escape key', async ({ page }) => {
    await page.locator('[data-demo-card] .demo-icon-button').click();
    await expect(page.locator('[data-demo-card]')).toBeHidden();

    await page.locator('[data-demo="start-tour"]').click();
    await page.getByRole('button', { name: 'Exit guided tour' }).click();
    await expect(page.locator('[data-demo-card]')).toBeHidden();

    await page.locator('[data-demo="start-tour"]').click();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-demo-card]')).toBeHidden();
  });

  test('drives from the keyboard, for a presenter at a podium', async ({ page }) => {
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('[data-demo-card]')).toContainText('STEP 02');
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('[data-demo-card]')).toContainText('STEP 01');
  });
});

function assertUniqueTitles(titles: string[]): void {
  expect(new Set(titles).size).toBe(titles.length);
}
