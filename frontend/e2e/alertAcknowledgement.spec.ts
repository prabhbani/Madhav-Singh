import { expect, test } from '@playwright/test';
import { alertFor, installApiMocks, notificationCentre } from './fixtures/api';

/**
 * Alert acknowledgement.
 *
 * The notification centre is where the early warning system meets a person. The
 * properties that matter are that an alert carries its evidence, that
 * acknowledging one records the decision, and that the queue does not re-present
 * something already handled.
 */
test.describe('alert acknowledgement', () => {
  test.beforeEach(async ({ page }) => {
    await installApiMocks(page, {
      alerts: [
        alertFor(),
        alertFor({
          id: 'alert-2',
          type: 'COMPENSATION_BACKLOG',
          severity: 'HIGH',
          message: 'Compensation has been in processing for 80 day(s), at or beyond the 75-day threshold.',
          trigger: 'payment_processing_days = 80 >= 75 (HIGH rung)',
          recommendedAction: 'Escalate the ageing compensation cases to the departmental payment review.',
          responsibleDepartment: 'Finance and Compensation Department',
        }),
        alertFor({
          id: 'alert-3',
          type: 'DOCUMENT_VERIFICATION_BACKLOG',
          severity: 'WARNING',
          status: 'ACKNOWLEDGED',
          acknowledgedAt: new Date().toISOString(),
          message: 'Nine submitted documents are awaiting verification.',
          trigger: 'document_verification_pending_count = 9 >= 8 (WARNING rung)',
          recommendedAction: 'Clear the verification backlog.',
          responsibleDepartment: 'Revenue Department',
        }),
      ],
    });
    await page.goto('/alerts');
  });

  test('groups the queue by severity, most severe first', async ({ page }) => {
    const headings = await page.locator('.alert-group > h2').allInnerTexts();
    const order = headings.map((heading) => heading.split('\n')[0]!.trim());
    expect(order[0]).toBe('CRITICAL');
    expect(order).toContain('HIGH');
  });

  test('summarises the counts a badge needs', async ({ page }) => {
    const summary = page.locator('.alert-summary');
    await expect(summary).toBeVisible();
    await expect(summary.getByText('CRITICAL')).toBeVisible();
    await expect(summary.getByText('AWAITING ACTION')).toBeVisible();
    const expected = notificationCentre().counts;
    expect(expected.total).toBeGreaterThan(0);
  });

  test('shows the condition that fired, not only a message', async ({ page }) => {
    const first = page.locator('.alert-item').first();
    await expect(first.locator('code')).toContainText('milestone_overdue_days = 47 >= 45');
    await expect(first).toContainText('Land Acquisition Cell');
    await expect(first).toContainText('Assign an accountable officer');
  });

  test('acknowledges an alert and reflects the decision immediately', async ({ page }) => {
    const first = page.locator('.alert-item').first();
    await expect(first.getByRole('button', { name: 'Acknowledge' })).toBeVisible();
    await first.getByRole('button', { name: 'Acknowledge' }).click();

    await expect(first.locator('.alert-ack')).toBeVisible();
    await expect(first.getByRole('button', { name: 'Acknowledge' })).toBeHidden();
  });

  test('does not offer to acknowledge something already acknowledged', async ({ page }) => {
    await page.getByRole('button', { name: 'Warning' }).click();
    const acknowledged = page.locator('.alert-item.is-acknowledged');
    await expect(acknowledged.first()).toBeVisible();
    await expect(acknowledged.first().getByRole('button', { name: 'Acknowledge' })).toBeHidden();
  });

  test('filters the queue by severity', async ({ page }) => {
    await page.getByRole('button', { name: 'Critical' }).click();
    const headings = await page.locator('.alert-group > h2').allInnerTexts();
    expect(headings.length).toBe(1);
    expect(headings[0]).toContain('CRITICAL');
  });

  test('states that a threshold crossing is not a causal finding', async ({ page }) => {
    await expect(page.getByText(/not a causal finding/i)).toBeVisible();
  });

  test('reports an empty queue as good news rather than as an error', async ({ page }) => {
    await installApiMocks(page, { alerts: [] });
    await page.goto('/alerts');
    await expect(page.getByText('No live alerts')).toBeVisible();
  });
});
