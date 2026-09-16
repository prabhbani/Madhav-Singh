import { test as base, type Page, type Route } from '@playwright/test';

/**
 * API mocking for the end-to-end suite.
 *
 * Every request the app makes is answered here, so the suite tests the
 * interface rather than the backend. Payload shapes match the API contract; if
 * one drifts, the schema parsing in the app rejects it and the test fails, which
 * is the signal we want.
 *
 * With `E2E_LIVE_API` set, the mocks are not installed and the app talks to the
 * real backend instead.
 */

export const LIVE_API = process.env.E2E_LIVE_API;

export type Role = 'SUPER_ADMIN' | 'STATE_ADMIN' | 'DISTRICT_OFFICER' | 'PROJECT_OFFICER' | 'ANALYST' | 'VIEWER';

const PERMISSIONS: Record<Role, string[]> = {
  SUPER_ADMIN: [
    'projects:read', 'projects:create', 'projects:update', 'projects:delete',
    'cases:read', 'cases:create', 'cases:update', 'cases:delete',
    'documents:read', 'documents:create', 'documents:update', 'documents:delete',
    'predictions:read', 'predictions:create', 'analytics:read', 'analytics:export',
    'alerts:read', 'alerts:acknowledge', 'alerts:manage', 'alerts:evaluate',
    'recommendations:read', 'recommendations:generate', 'recommendations:manage',
    'users:read', 'users:create', 'users:update', 'users:deactivate',
    'auditLogs:read', 'auditLogs:export',
  ],
  STATE_ADMIN: ['projects:read', 'projects:create', 'projects:update', 'cases:read', 'documents:read', 'predictions:read', 'predictions:create', 'analytics:read', 'analytics:export', 'alerts:read', 'alerts:acknowledge', 'alerts:manage', 'recommendations:read', 'users:read', 'auditLogs:read'],
  DISTRICT_OFFICER: ['projects:read', 'projects:create', 'projects:update', 'cases:read', 'cases:create', 'documents:read', 'predictions:read', 'predictions:create', 'analytics:read', 'alerts:read', 'alerts:acknowledge', 'alerts:manage', 'recommendations:read', 'recommendations:generate', 'users:read'],
  PROJECT_OFFICER: ['projects:read', 'projects:update', 'cases:read', 'documents:read', 'predictions:read', 'analytics:read', 'alerts:read', 'alerts:acknowledge', 'recommendations:read'],
  ANALYST: ['projects:read', 'cases:read', 'documents:read', 'predictions:read', 'predictions:create', 'analytics:read', 'analytics:export', 'alerts:read', 'recommendations:read'],
  VIEWER: ['projects:read', 'cases:read', 'predictions:read', 'analytics:read', 'alerts:read', 'recommendations:read'],
};

export const session = (role: Role) => ({
  user: {
    id: 'user-1',
    email: `${role.toLowerCase()}@test.gov`,
    role,
    stateCode: 'Punjab',
    districtCode: role === 'DISTRICT_OFFICER' || role === 'PROJECT_OFFICER' ? 'Ludhiana' : null,
    department: role === 'PROJECT_OFFICER' ? 'Public Works Department' : null,
  },
  scope: {
    level: role === 'SUPER_ADMIN' ? 'GLOBAL' : role === 'PROJECT_OFFICER' ? 'DEPARTMENT' : role === 'DISTRICT_OFFICER' ? 'DISTRICT' : 'STATE',
    stateCode: 'Punjab',
    districtCode: role === 'DISTRICT_OFFICER' || role === 'PROJECT_OFFICER' ? 'Ludhiana' : null,
    department: role === 'PROJECT_OFFICER' ? 'Public Works Department' : null,
    basis: 'Scope for the end-to-end run.',
  },
  permissions: PERMISSIONS[role],
});

export const alertFor = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 'alert-1',
  type: 'MILESTONE_OVERDUE',
  severity: 'CRITICAL',
  status: 'OPEN',
  message: 'Milestone "Section 19 declaration" is 47 day(s) past its planned date.',
  trigger: 'milestone_overdue_days = 47 >= 45 (CRITICAL rung)',
  recommendedAction: 'Assign an accountable officer and agree a revised completion date.',
  responsibleDepartment: 'Land Acquisition Cell',
  triggeredAt: new Date(Date.now() - 3_600_000).toISOString(),
  lastObservedAt: new Date().toISOString(),
  occurrenceCount: 1,
  acknowledgedAt: null,
  assignedTo: null,
  project: { projectCode: 'PB-LDH-2026-001', name: 'Ludhiana Ring Road Phase II', district: 'Ludhiana' },
  ...overrides,
});

export const notificationCentre = (alerts = [alertFor()]) => ({
  generatedAt: new Date().toISOString(),
  counts: {
    total: alerts.length,
    unacknowledged: alerts.filter((alert) => alert.status === 'OPEN').length,
    CRITICAL: alerts.filter((alert) => alert.severity === 'CRITICAL').length,
    HIGH: alerts.filter((alert) => alert.severity === 'HIGH').length,
    WARNING: alerts.filter((alert) => alert.severity === 'WARNING').length,
    INFO: alerts.filter((alert) => alert.severity === 'INFO').length,
  },
  groups: (['CRITICAL', 'HIGH', 'WARNING', 'INFO'] as const)
    .map((severity) => ({ severity, alerts: alerts.filter((alert) => alert.severity === severity) }))
    .filter((group) => group.alerts.length > 0),
});

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

export type MockOptions = {
  role?: Role;
  alerts?: ReturnType<typeof alertFor>[];
  /** Routes answered before the defaults, for a test that needs its own reply. */
  overrides?: Array<{ pattern: string | RegExp; handler: (route: Route) => Promise<void> | void }>;
};

/** Installs the API mocks on a page. A no-op when running against a live API. */
export const installApiMocks = async (page: Page, options: MockOptions = {}): Promise<void> => {
  if (LIVE_API) return;
  const role = options.role ?? 'DISTRICT_OFFICER';

  // Registration order matters: Playwright matches the most recently registered
  // route first, so the catch-all goes down before anything specific or it
  // swallows every mock.
  await page.route('**/api/v1/**', (route) => json(route, { error: { code: 'NOT_MOCKED', message: 'add a mock' } }, 501));

  await page.route('**/api/v1/auth/me', (route) => json(route, session(role)));
  await page.route('**/api/v1/notifications*', (route) => json(route, notificationCentre(options.alerts)));
  await page.route('**/api/v1/alerts/*/acknowledge', (route) =>
    json(route, { ...alertFor(), status: 'ACKNOWLEDGED', acknowledgedAt: new Date().toISOString() }),
  );

  // A test's own replies are registered last so they win over the defaults.
  for (const override of options.overrides ?? []) {
    await page.route(override.pattern, override.handler);
  }
};

export const test = base.extend<{ mockRole: Role }>({
  mockRole: ['DISTRICT_OFFICER', { option: true }],
});

export { expect } from '@playwright/test';
