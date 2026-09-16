import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { disconnect, resetDatabase, seedProjects, skipUnlessIntegration } from '../helpers/integration.js';

/**
 * Database integration.
 *
 * Exercises the constraints and defaults the schema promises. A unit test cannot
 * prove a unique index exists; only the database can refuse the second insert.
 */
describe('database', { skip: skipUnlessIntegration }, () => {
  let prisma: Awaited<typeof import('../../src/config/prisma.js')>['prisma'];
  let projects: Awaited<ReturnType<typeof seedProjects>>;

  before(async () => {
    ({ prisma } = await import('../../src/config/prisma.js'));
    await resetDatabase();
    projects = await seedProjects();
  });

  after(async () => {
    await resetDatabase();
    await disconnect();
  });

  it('connects and answers a trivial query', async () => {
    const count = await prisma.project.count();
    assert.equal(count, 4);
  });

  it('refuses a duplicate project code', async () => {
    await assert.rejects(
      prisma.project.create({
        data: {
          projectCode: 'PB-LDH-2026-001',
          name: 'Duplicate import',
          state: 'Punjab',
          district: 'Ludhiana',
          department: 'Public Works Department',
          projectType: 'HIGHWAY',
          plannedStartDate: new Date('2026-01-01'),
          targetDate: new Date('2026-12-01'),
        },
      }),
      /Unique constraint/i,
    );
  });

  it('keeps one live alert per project and detector type', async () => {
    const base = {
      projectId: projects.ludhianaPwd!.id,
      type: 'MILESTONE_OVERDUE',
      severity: 'HIGH' as const,
      message: 'Milestone is overdue',
      trigger: 'milestone_overdue_days = 26 >= 21',
      recommendedAction: 'Assign an accountable officer',
      responsibleDepartment: 'Public Works Department',
      responsibilityBasis: 'Owning department',
      conditionHash: 'abc123',
      policyVersion: 'early-warning-policy-v1',
      detectorVersion: 'early-warning-detectors-v1',
    };
    await prisma.alert.create({ data: base });
    await assert.rejects(prisma.alert.create({ data: base }), /Unique constraint/i);

    // The upsert path the service uses must update rather than collide.
    const updated = await prisma.alert.upsert({
      where: { projectId_type: { projectId: base.projectId, type: base.type } },
      update: { severity: 'CRITICAL', occurrenceCount: 2 },
      create: base,
    });
    assert.equal(updated.severity, 'CRITICAL');
    assert.equal(updated.occurrenceCount, 2);
    assert.equal(await prisma.alert.count({ where: { projectId: base.projectId } }), 1);
  });

  it('keeps one recommendation per project and evidence code', async () => {
    const base = {
      projectId: projects.ludhianaPwd!.id,
      type: 'ADMINISTRATIVE_BOTTLENECK',
      title: 'Complete ownership verification',
      rationale: 'Twenty-three parcels are unresolved',
      priority: 'HIGH',
      evidenceCode: 'OWNERSHIP_UNRESOLVED',
      responsibleDepartment: 'Land Records Department',
      expectedImpact: 'May reduce the administrative bottleneck',
      policyVersion: 'recommendation-policy-v1',
      catalogVersion: 'recommendation-catalog-v1',
    };
    await prisma.recommendation.create({ data: base });
    await assert.rejects(prisma.recommendation.create({ data: base }), /Unique constraint/i);
  });

  it('cascades a project deletion to its children, leaving no orphans', async () => {
    const project = await prisma.project.create({
      data: {
        projectCode: 'PB-TMP-2026-999',
        name: 'Temporary',
        state: 'Punjab',
        district: 'Ludhiana',
        department: 'Public Works Department',
        projectType: 'HIGHWAY',
        plannedStartDate: new Date('2026-01-01'),
        targetDate: new Date('2026-12-01'),
      },
    });
    await prisma.milestone.create({
      data: { projectId: project.id, name: 'Section 19 declaration', plannedAt: new Date('2026-06-01') },
    });
    await prisma.document.create({ data: { projectId: project.id, documentType: 'TITLE_DEED' } });

    await prisma.project.delete({ where: { id: project.id } });
    assert.equal(await prisma.milestone.count({ where: { projectId: project.id } }), 0);
    assert.equal(await prisma.document.count({ where: { projectId: project.id } }), 0);
  });

  it('applies the documented column defaults', async () => {
    const project = await prisma.project.create({
      data: {
        projectCode: 'PB-DEF-2026-005',
        name: 'Defaults check',
        state: 'Punjab',
        district: 'Ludhiana',
        department: 'Public Works Department',
        projectType: 'HIGHWAY',
        plannedStartDate: new Date('2026-01-01'),
        targetDate: new Date('2026-12-01'),
      },
    });
    assert.equal(project.status, 'DRAFT');
    assert.equal(project.priority, 'MEDIUM');
    assert.equal(project.dataOrigin, 'USER_ENTERED');
    assert.ok(project.createdAt instanceof Date);
  });

  it('stores a decimal probability without losing precision', async () => {
    const prediction = await prisma.prediction.create({
      data: {
        projectId: projects.ludhianaPwd!.id,
        modelVersion: 'synthetic-delay-20260915T173246Z',
        horizonDays: 90,
        delayProbability: 0.82345,
        riskLevel: 'HIGH',
        inputSnapshot: { parcel_count: 184 },
      },
    });
    assert.equal(prediction.delayProbability.toNumber(), 0.82345);
  });

  it('writes an append-only alert history row', async () => {
    const alert = await prisma.alert.findFirst({ where: { projectId: projects.ludhianaPwd!.id } });
    assert.ok(alert);
    await prisma.alertEvent.create({
      data: {
        alertId: alert.id,
        eventType: 'RAISED',
        severityAfter: 'HIGH',
        statusAfter: 'OPEN',
        reason: 'First threshold crossing',
      },
    });
    const events = await prisma.alertEvent.findMany({ where: { alertId: alert.id } });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.eventType, 'RAISED');
  });

  it('rolls a failed transaction back completely', async () => {
    const before = await prisma.project.count();
    await assert.rejects(
      prisma.$transaction(async (tx) => {
        await tx.project.create({
          data: {
            projectCode: 'PB-TXN-2026-006',
            name: 'Transaction check',
            state: 'Punjab',
            district: 'Ludhiana',
            department: 'Public Works Department',
            projectType: 'HIGHWAY',
            plannedStartDate: new Date('2026-01-01'),
            targetDate: new Date('2026-12-01'),
          },
        });
        // Colliding on the seeded code forces the whole transaction to unwind.
        await tx.project.create({
          data: {
            projectCode: 'PB-LDH-2026-001',
            name: 'Collision',
            state: 'Punjab',
            district: 'Ludhiana',
            department: 'Public Works Department',
            projectType: 'HIGHWAY',
            plannedStartDate: new Date('2026-01-01'),
            targetDate: new Date('2026-12-01'),
          },
        });
      }),
    );
    assert.equal(await prisma.project.count(), before, 'the first insert should not have survived');
  });
});
