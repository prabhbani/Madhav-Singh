/**
 * Demo seed.
 *
 * Creates one account per role with a distinct geographic scope, so role and
 * scope behaviour can be exercised end to end. Every account uses the same
 * password from the environment; this seed is for a demo environment only and
 * must not be run against a real deployment.
 */

import bcrypt from 'bcryptjs';
import { PrismaClient, Role } from '@prisma/client';

const prisma = new PrismaClient();

const password = process.env.DEMO_ADMIN_PASSWORD;
if (!password || password.length < 12) {
  throw new Error('Set DEMO_ADMIN_PASSWORD to a 12-character minimum value before seeding');
}

const passwordHash = await bcrypt.hash(password, 12);

const accounts: Array<{
  email: string;
  displayName: string;
  role: Role;
  stateCode?: string;
  districtCode?: string;
  department?: string;
}> = [
  { email: 'super.admin@example.gov', displayName: 'Demo Super Administrator', role: Role.SUPER_ADMIN },
  { email: 'state.admin@example.gov', displayName: 'Demo State Administrator', role: Role.STATE_ADMIN, stateCode: 'Punjab' },
  {
    email: 'district.officer@example.gov',
    displayName: 'Demo District Officer',
    role: Role.DISTRICT_OFFICER,
    stateCode: 'Punjab',
    districtCode: 'Ludhiana',
  },
  {
    email: 'project.officer@example.gov',
    displayName: 'Demo Project Officer',
    role: Role.PROJECT_OFFICER,
    stateCode: 'Punjab',
    districtCode: 'Ludhiana',
    department: 'Public Works Department',
  },
  { email: 'analyst@example.gov', displayName: 'Demo Analyst', role: Role.ANALYST, stateCode: 'Punjab' },
  { email: 'viewer@example.gov', displayName: 'Demo Viewer', role: Role.VIEWER, stateCode: 'Punjab' },
];

for (const account of accounts) {
  await prisma.user.upsert({
    where: { email: account.email },
    update: {
      passwordHash,
      active: true,
      role: account.role,
      stateCode: account.stateCode ?? null,
      districtCode: account.districtCode ?? null,
      department: account.department ?? null,
    },
    create: {
      email: account.email,
      passwordHash,
      displayName: account.displayName,
      role: account.role,
      stateCode: account.stateCode ?? null,
      districtCode: account.districtCode ?? null,
      department: account.department ?? null,
    },
  });
}

await prisma.$disconnect();
console.log(`Seeded ${accounts.length} demo accounts, one per role, from DEMO_ADMIN_PASSWORD`);
