/**
 * Integration test harness.
 *
 * These tests drive the real Express application over HTTP against a real
 * PostgreSQL database. That is the only way to exercise the parts the unit
 * suites cannot reach: middleware ordering, Prisma queries, scope filters
 * applied in SQL, audit rows actually being written, and rate limiting.
 *
 * The harness is gated. Without `DATABASE_URL` and `JWT_SECRET` the suites skip
 * with a message rather than failing, so a contributor without a database still
 * gets a green unit run. Every application import is dynamic, because the
 * configuration module validates the environment at import time and would throw
 * before a skip could take effect.
 *
 * The database is destroyed and rebuilt between suites. Point `DATABASE_URL` at
 * a disposable database, never at one holding real records.
 */

import type { Server } from 'node:http';

export const INTEGRATION_SKIP_REASON =
  'set DATABASE_URL and JWT_SECRET to a disposable test database to run integration tests';

/** True when the environment can support an integration run. */
export const integrationEnabled = Boolean(process.env.DATABASE_URL && (process.env.JWT_SECRET ?? '').length >= 32);

/** `skip` value for node:test, so a suite reports why it did not run. */
export const skipUnlessIntegration = integrationEnabled ? false : INTEGRATION_SKIP_REASON;

export type TestResponse<T = unknown> = {
  status: number;
  body: T;
  headers: Headers;
};

export type Harness = {
  baseUrl: string;
  /** Issues a request; a token is attached as a Bearer credential when given. */
  call: <T = unknown>(
    method: string,
    path: string,
    options?: { token?: string; body?: unknown; headers?: Record<string, string> },
  ) => Promise<TestResponse<T>>;
  close: () => Promise<void>;
};

let cachedHarness: Harness | null = null;

/** Boots the application on an ephemeral port. Reused across a suite. */
export const startHarness = async (): Promise<Harness> => {
  if (cachedHarness) return cachedHarness;

  const { app } = await import('../../src/app.js');
  const server: Server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind a port');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  cachedHarness = {
    baseUrl,
    async call(method, path, options = {}) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          ...options.headers,
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      const text = await response.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      return { status: response.status, body: body as never, headers: response.headers };
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      cachedHarness = null;
    },
  };
  return cachedHarness;
};

/** Truncates every table, leaving the schema intact. */
export const resetDatabase = async (): Promise<void> => {
  const { prisma } = await import('../../src/config/prisma.js');
  // Ordered so a child is removed before its parent, avoiding constraint noise.
  await prisma.alertEvent.deleteMany();
  await prisma.alert.deleteMany();
  await prisma.recommendation.deleteMany();
  await prisma.prediction.deleteMany();
  await prisma.document.deleteMany();
  await prisma.milestone.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.project.deleteMany();
  await prisma.user.deleteMany();
};

export type SeededAccount = { id: string; email: string; role: string; token: string };

export const TEST_PASSWORD = 'Ludhiana7Ring9Road';

/**
 * One account per role, scoped so cross-scope access can be tested.
 *
 * Punjab holds Ludhiana and Amritsar; Haryana is a second state that only the
 * super administrator can reach.
 */
export const seedAccounts = async (): Promise<Record<string, SeededAccount>> => {
  const { prisma } = await import('../../src/config/prisma.js');
  const { signToken } = await import('../../src/middlewares/auth.js');
  const bcrypt = (await import('bcryptjs')).default;

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  const definitions = [
    { key: 'superAdmin', email: 'super.admin@test.gov', role: 'SUPER_ADMIN' as const },
    { key: 'stateAdmin', email: 'state.admin@test.gov', role: 'STATE_ADMIN' as const, stateCode: 'Punjab' },
    {
      key: 'districtOfficer',
      email: 'district.officer@test.gov',
      role: 'DISTRICT_OFFICER' as const,
      stateCode: 'Punjab',
      districtCode: 'Ludhiana',
    },
    {
      key: 'projectOfficer',
      email: 'project.officer@test.gov',
      role: 'PROJECT_OFFICER' as const,
      stateCode: 'Punjab',
      districtCode: 'Ludhiana',
      department: 'Public Works Department',
    },
    { key: 'analyst', email: 'analyst@test.gov', role: 'ANALYST' as const, stateCode: 'Punjab' },
    { key: 'viewer', email: 'viewer@test.gov', role: 'VIEWER' as const, stateCode: 'Punjab' },
    // A neighbouring state, used to prove scope keeps records apart.
    { key: 'otherStateAdmin', email: 'haryana.admin@test.gov', role: 'STATE_ADMIN' as const, stateCode: 'Haryana' },
  ];

  const accounts: Record<string, SeededAccount> = {};
  for (const definition of definitions) {
    const user = await prisma.user.create({
      data: {
        email: definition.email,
        passwordHash,
        displayName: definition.email,
        role: definition.role,
        stateCode: definition.stateCode ?? null,
        districtCode: definition.districtCode ?? null,
        department: definition.department ?? null,
      },
    });
    accounts[definition.key] = {
      id: user.id,
      email: user.email,
      role: user.role,
      token: signToken({
        sub: user.id,
        email: user.email,
        role: user.role,
        stateCode: user.stateCode ?? undefined,
        districtCode: user.districtCode ?? undefined,
        department: user.department ?? undefined,
      }),
    };
  }
  return accounts;
};

export type SeededProject = { id: string; projectCode: string; state: string; district: string; department: string };

/** Three projects spread across two states, so scope filtering has something to do. */
export const seedProjects = async (): Promise<Record<string, SeededProject>> => {
  const { prisma } = await import('../../src/config/prisma.js');
  const definitions = [
    {
      key: 'ludhianaPwd',
      projectCode: 'PB-LDH-2026-001',
      name: 'Ludhiana Ring Road Phase II',
      state: 'Punjab',
      district: 'Ludhiana',
      department: 'Public Works Department',
    },
    {
      key: 'ludhianaWater',
      projectCode: 'PB-LDH-2026-002',
      name: 'Sutlej Canal Modernisation',
      state: 'Punjab',
      district: 'Ludhiana',
      department: 'Water Resources',
    },
    {
      key: 'amritsar',
      projectCode: 'PB-ASR-2026-003',
      name: 'Amritsar Bypass',
      state: 'Punjab',
      district: 'Amritsar',
      department: 'Public Works Department',
    },
    {
      key: 'haryana',
      projectCode: 'HR-GGN-2026-004',
      name: 'Gurugram Metro Corridor',
      state: 'Haryana',
      district: 'Gurugram',
      department: 'Public Works Department',
    },
  ];

  const projects: Record<string, SeededProject> = {};
  for (const definition of definitions) {
    const project = await prisma.project.create({
      data: {
        projectCode: definition.projectCode,
        name: definition.name,
        state: definition.state,
        district: definition.district,
        department: definition.department,
        projectType: 'HIGHWAY',
        priority: 'HIGH',
        status: 'ACTIVE',
        plannedStartDate: new Date('2026-01-01'),
        targetDate: new Date('2026-12-01'),
        dataOrigin: 'SYNTHETIC_DEMO',
      },
    });
    projects[definition.key] = {
      id: project.id,
      projectCode: project.projectCode,
      state: project.state,
      district: project.district,
      department: project.department,
    };
  }
  return projects;
};

/** Tears down the Prisma connection so the test process can exit. */
export const disconnect = async (): Promise<void> => {
  const { prisma } = await import('../../src/config/prisma.js');
  await prisma.$disconnect();
};
