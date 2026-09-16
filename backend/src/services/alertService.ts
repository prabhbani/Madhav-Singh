/**
 * Early warning service.
 *
 * Assembles the detector input from the operational tables, runs the pure alert
 * engine, then persists exactly what the engine decided. It never re-decides
 * severity or whether to notify; those belong to the engine and its policy.
 *
 * Persistence keeps one row per project and detector type, an immutable event
 * per state change, and a history row only when something actually changed.
 */

import { Prisma, type AlertSeverity as PrismaSeverity, type AlertStatus as PrismaStatus } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { AppError } from '../errors/AppError.js';
import { predictionService } from './predictionService.js';
import { evaluateAlerts } from '../alerts/engine.js';
import { ALERT_POLICY_VERSION, DETECTOR_POLICY, DETECTOR_VERSION, SEVERITY_ORDER } from '../alerts/policy.js';
import { notificationService, type NotificationEvent } from '../notifications/notificationService.js';
import {
  OPEN_ALERT_STATUSES,
  deriveCurrentMilestone,
  deriveDepartmentWorkload,
  deriveMetrics,
  deriveOpenMilestones,
  projectInclude,
  readMetricsFromSnapshot,
  toNumber,
  type ProjectWithRelations,
} from './caseSnapshot.js';
import type {
  AlertEvaluationInput,
  AlertEvaluationResult,
  AlertSeverity,
  AlertType,
  DetectedAlert,
  ExistingAlert,
  ObservationHistoryPoint,
  OfficerAssignment,
  PredictionContext,
  PredictionHistoryPoint,
} from '../alerts/types.js';
import type { RiskLevel } from '../recommendations/types.js';
import { nestedProjectScopeWhere, projectScopeWhere, type AccessScope } from '../authz/scope.js';

const LIVE_STATUSES = [...OPEN_ALERT_STATUSES];
const TERMINAL_STATUSES: readonly PrismaStatus[] = ['RESOLVED', 'DISMISSED'];

/** Statuses an officer may set directly. */
const OFFICER_STATUSES: readonly PrismaStatus[] = ['ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLVED', 'DISMISSED'];

const EVENT_FOR_DECISION: Record<DetectedAlert['decision'], 'RAISED' | 'ESCALATED' | 'DE_ESCALATED' | 'OBSERVED' | 'REOPENED' | 'RESOLVED'> = {
  CREATED: 'RAISED',
  ESCALATED: 'ESCALATED',
  DE_ESCALATED: 'DE_ESCALATED',
  UNCHANGED: 'OBSERVED',
  REOPENED: 'REOPENED',
  RESOLVED: 'RESOLVED',
};

const NOTIFICATION_FOR_DECISION: Partial<Record<DetectedAlert['decision'], NotificationEvent['type']>> = {
  CREATED: 'ALERT_CREATED',
  ESCALATED: 'ALERT_ESCALATED',
  REOPENED: 'ALERT_REOPENED',
};

// ---------------------------------------------------------------------------
// Input assembly
// ---------------------------------------------------------------------------

/**
 * Officers accountable for a department, best match first.
 *
 * The directory has no department-to-district mapping table, so matching is by
 * the officer's own recorded department, district, and state. The basis string
 * records which rule matched, and the engine reports when no officer was found.
 */
const deriveResponsibleOfficers = async (project: ProjectWithRelations): Promise<OfficerAssignment[]> => {
  const users = await prisma.user.findMany({
    where: {
      active: true,
      OR: [
        { department: { not: null } },
        { role: 'DISTRICT_OFFICER', districtCode: project.district },
        { role: 'STATE_ADMIN', stateCode: project.state },
      ],
    },
    select: { id: true, displayName: true, role: true, department: true, districtCode: true, stateCode: true },
    take: 500,
  });

  const scored: Array<OfficerAssignment & { score: number }> = [];
  for (const user of users) {
    if (user.department && user.districtCode === project.district) {
      scored.push({
        department: user.department,
        officerId: user.id,
        officerName: user.displayName,
        role: user.role,
        districtCode: user.districtCode,
        stateCode: user.stateCode,
        matchBasis: 'Officer recorded for this department in this district.',
        score: 4,
      });
    } else if (user.department) {
      scored.push({
        department: user.department,
        officerId: user.id,
        officerName: user.displayName,
        role: user.role,
        districtCode: user.districtCode,
        stateCode: user.stateCode,
        matchBasis: 'Officer recorded for this department.',
        score: 3,
      });
    } else if (user.role === 'DISTRICT_OFFICER' && user.districtCode === project.district) {
      scored.push({
        department: project.department,
        officerId: user.id,
        officerName: user.displayName,
        role: user.role,
        districtCode: user.districtCode,
        stateCode: user.stateCode,
        matchBasis: 'District officer for this project, matched because no department officer is recorded.',
        score: 2,
      });
    } else if (user.role === 'STATE_ADMIN' && user.stateCode === project.state) {
      scored.push({
        department: project.department,
        officerId: user.id,
        officerName: user.displayName,
        role: user.role,
        districtCode: user.districtCode,
        stateCode: user.stateCode,
        matchBasis: 'State administrator, matched because no district or department officer is recorded.',
        score: 1,
      });
    }
  }

  scored.sort((left, right) => right.score - left.score || left.officerId.localeCompare(right.officerId));
  const best = new Map<string, OfficerAssignment>();
  for (const { score: _score, ...officer } of scored) {
    if (!best.has(officer.department)) best.set(officer.department, officer);
  }
  return [...best.values()];
};

/** Past predictions, oldest first, for the trend and jump detectors. */
const derivePredictionHistory = (project: ProjectWithRelations): PredictionHistoryPoint[] =>
  project.predictions
    .slice()
    .sort((left, right) => left.predictedAt.getTime() - right.predictedAt.getTime())
    .map((prediction) => ({
      predictionId: prediction.id,
      predictedAt: prediction.predictedAt,
      delayProbability: prediction.delayProbability.toNumber(),
      riskLevel: prediction.riskLevel as RiskLevel,
    }));

/**
 * Past measurements, read back from the feature snapshot stored with each
 * prediction. Points whose snapshot carried no usable metric are dropped, so a
 * detector never compares against an empty observation.
 */
const deriveObservationHistory = (project: ProjectWithRelations): ObservationHistoryPoint[] =>
  project.predictions
    .slice()
    .sort((left, right) => left.predictedAt.getTime() - right.predictedAt.getTime())
    .map((prediction) => ({ observedAt: prediction.predictedAt, metrics: readMetricsFromSnapshot(prediction.inputSnapshot) }))
    .filter((point) => Object.keys(point.metrics).length > 0);

const buildPredictionContext = async (
  project: ProjectWithRelations,
  horizonDays: number,
  asOfAt: Date,
): Promise<PredictionContext> => {
  const stored = project.predictions[0];
  if (stored) {
    return {
      predictionId: stored.id,
      riskLevel: stored.riskLevel as RiskLevel,
      delayProbability: stored.delayProbability.toNumber(),
      expectedDelayDays: stored.expectedDelayDays ? stored.expectedDelayDays.toNumber() : null,
      horizonDays: stored.horizonDays,
      confidenceBand: (stored.confidenceBand as PredictionContext['confidenceBand']) ?? null,
      predictionStatus: 'OK',
      modelVersion: stored.modelVersion,
      predictedAt: stored.predictedAt,
    };
  }
  const live = (await predictionService.predict(project.id, horizonDays, asOfAt)) as Record<string, unknown>;
  return {
    riskLevel: (typeof live.riskLevel === 'string' ? live.riskLevel : 'LOW') as RiskLevel,
    delayProbability: toNumber(live.delayProbability) ?? 0,
    expectedDelayDays: toNumber(live.expectedDelayDays) ?? null,
    horizonDays,
    confidenceBand: typeof live.confidenceBand === 'string' ? (live.confidenceBand as PredictionContext['confidenceBand']) : 'LOW',
    predictionStatus:
      live.predictionStatus === 'RULE_ONLY_FALLBACK' || live.predictionStatus === 'STALE' || live.predictionStatus === 'DEGRADED'
        ? live.predictionStatus
        : 'OK',
    modelVersion: typeof live.modelVersion === 'string' ? live.modelVersion : undefined,
    predictedAt: asOfAt,
  };
};

export type EvaluateOptions = {
  asOfAt?: Date;
  horizonDays?: number;
  persist?: boolean;
  notify?: boolean;
  /** Measurements from a richer feature snapshot, overriding derived values. */
  snapshot?: {
    metrics?: AlertEvaluationInput['project']['metrics'];
    departmentWorkload?: AlertEvaluationInput['departmentWorkload'];
    predictionHistory?: PredictionHistoryPoint[];
    observationHistory?: ObservationHistoryPoint[];
  };
};

export const buildAlertInput = async (
  projectId: string,
  options: EvaluateOptions = {},
): Promise<AlertEvaluationInput> => {
  const project = await prisma.project.findUnique({ where: { id: projectId }, include: projectInclude });
  if (!project) throw new AppError(404, 'PROJECT_NOT_FOUND', 'Project was not found');

  const asOfAt = options.asOfAt ?? new Date();
  const horizonDays = options.horizonDays ?? 90;
  const supplied = options.snapshot ?? {};

  const [prediction, departmentWorkload, responsibleOfficers, storedAlerts] = await Promise.all([
    buildPredictionContext(project, horizonDays, asOfAt),
    supplied.departmentWorkload ? Promise.resolve(supplied.departmentWorkload) : deriveDepartmentWorkload(asOfAt),
    deriveResponsibleOfficers(project),
    prisma.alert.findMany({ where: { projectId } }),
  ]);

  const existingAlerts: ExistingAlert[] = storedAlerts.map((alert) => ({
    alertId: alert.id,
    alertType: alert.type,
    severity: alert.severity as AlertSeverity,
    status: alert.status,
    conditionHash: alert.conditionHash,
    occurrenceCount: alert.occurrenceCount,
    firstTriggeredAt: alert.firstTriggeredAt,
    lastObservedAt: alert.lastObservedAt,
    cooldownUntil: alert.cooldownUntil,
    lastNotifiedAt: alert.lastNotifiedAt,
    acknowledgedAt: alert.acknowledgedAt,
    assignedToId: alert.assignedToId,
  }));

  return {
    asOfAt,
    project: {
      projectId: project.id,
      projectCode: project.projectCode,
      name: project.name,
      state: project.state,
      district: project.district,
      department: project.department,
      projectType: project.projectType,
      status: project.status,
      targetDate: project.targetDate,
      dataOrigin: project.dataOrigin,
      metrics: {
        ...deriveMetrics(project, asOfAt),
        ...readMetricsFromSnapshot(project.predictions[0]?.inputSnapshot),
        ...(supplied.metrics ?? {}),
      },
    },
    currentMilestone: deriveCurrentMilestone(project, asOfAt),
    upcomingMilestones: deriveOpenMilestones(project),
    prediction,
    predictionHistory: supplied.predictionHistory ?? derivePredictionHistory(project),
    observationHistory: supplied.observationHistory ?? deriveObservationHistory(project),
    departmentWorkload,
    responsibleOfficers,
    existingAlerts,
  };
};

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const asJson = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value ?? {}));

/**
 * True when the measured value moved by at least the detector's material delta.
 * Used so a repeated sweep of an unchanged condition does not append a history
 * row on every run.
 */
const movedMaterially = (alertType: string, previous: unknown, current: number): boolean => {
  const policy = DETECTOR_POLICY[alertType as AlertType];
  if (!policy) return true;
  const before = toNumber(isRecordLike(previous) ? previous.measuredValue : undefined);
  if (before === undefined) return true;
  return Math.abs(current - before) >= policy.materialDelta;
};

const isRecordLike = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const persistAlert = async (
  projectId: string,
  alert: DetectedAlert,
  result: AlertEvaluationResult,
  modelVersion: string | null,
  predictionId: string | null,
): Promise<{ id: string; notified: boolean }> => {
  const existing = await prisma.alert.findUnique({ where: { projectId_type: { projectId, type: alert.alertType } } });
  const severity = alert.severity as PrismaSeverity;

  // An escalation or a re-raise puts an acknowledged alert back in front of an
  // officer: the condition they acknowledged is not the condition now recorded.
  const reopens = alert.decision === 'ESCALATED' || alert.decision === 'REOPENED';
  const status: PrismaStatus =
    !existing || reopens || TERMINAL_STATUSES.includes(existing.status) ? 'OPEN' : existing.status;

  const data = {
    severity,
    status,
    message: alert.description,
    trigger: alert.trigger,
    recommendedAction: alert.recommendedAction,
    responsibleDepartment: alert.responsible.department,
    responsibilityBasis: alert.responsible.basis,
    evidence: asJson(alert.evidence),
    conditionHash: alert.conditionHash,
    occurrenceCount: alert.acknowledgement.occurrenceCount,
    lastObservedAt: new Date(alert.acknowledgement.lastObservedAt),
    cooldownUntil: alert.cooldownUntil ? new Date(alert.cooldownUntil) : null,
    ...(alert.notify ? { lastNotifiedAt: new Date(result.asOfAt) } : {}),
    policyVersion: result.policyVersion,
    detectorVersion: result.detectorVersion,
    modelVersion,
    predictionId,
    assignedToId: alert.responsible.officerId,
    ...(status === 'OPEN' && existing?.status === 'ACKNOWLEDGED' ? { acknowledgedAt: null, acknowledgedById: null } : {}),
    ...(TERMINAL_STATUSES.includes(existing?.status ?? 'OPEN') ? { resolvedAt: null, resolutionReason: null } : {}),
  };

  const saved = await prisma.alert.upsert({
    where: { projectId_type: { projectId, type: alert.alertType } },
    update: data,
    create: {
      ...data,
      projectId,
      type: alert.alertType,
      firstTriggeredAt: new Date(alert.acknowledgement.firstTriggeredAt),
      triggeredAt: new Date(alert.triggeredAt),
    },
  });

  // An OBSERVED row is written only when the value actually moved, so the
  // history stays readable instead of recording every sweep.
  const worthRecording =
    alert.decision !== 'UNCHANGED' || movedMaterially(alert.alertType, existing?.evidence, alert.evidence.measuredValue);
  if (worthRecording) {
    await prisma.alertEvent.create({
      data: {
        alertId: saved.id,
        eventType: EVENT_FOR_DECISION[alert.decision],
        severityBefore: (existing?.severity as PrismaSeverity | undefined) ?? null,
        severityAfter: severity,
        statusBefore: existing?.status ?? null,
        statusAfter: status,
        reason: `${alert.decisionReason} ${alert.notifyBasis}`.trim(),
        evidence: asJson({ trigger: alert.trigger, evidence: alert.evidence, overrides: alert.appliedOverrides }),
        occurredAt: new Date(result.asOfAt),
      },
    });
  }

  return { id: saved.id, notified: alert.notify };
};

const persistResolution = async (projectId: string, alertType: string, reason: string, asOfAt: Date) => {
  const existing = await prisma.alert.findUnique({ where: { projectId_type: { projectId, type: alertType } } });
  if (!existing || TERMINAL_STATUSES.includes(existing.status)) return null;
  const saved = await prisma.alert.update({
    where: { id: existing.id },
    data: { status: 'RESOLVED', resolvedAt: asOfAt, resolutionReason: reason.split(':')[0] ?? 'CONDITION_CLEARED', cooldownUntil: null },
  });
  await prisma.alertEvent.create({
    data: {
      alertId: saved.id,
      eventType: 'RESOLVED',
      severityBefore: existing.severity,
      severityAfter: existing.severity,
      statusBefore: existing.status,
      statusAfter: 'RESOLVED',
      reason,
      occurredAt: asOfAt,
    },
  });
  return saved;
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export const alertService = {
  /** Runs every detector for one project and persists the engine's decisions. */
  async evaluate(projectId: string, options: EvaluateOptions = {}) {
    const input = await buildAlertInput(projectId, options);
    const result = evaluateAlerts(input);
    if (options.persist === false) return { ...result, persisted: false, notificationsSent: 0 };

    const asOfAt = new Date(result.asOfAt);
    const modelVersion = input.prediction.modelVersion ?? null;
    const predictionId = input.prediction.predictionId ?? null;

    const saved = new Map<string, string>();
    for (const alert of result.alerts) {
      const { id } = await persistAlert(projectId, alert, result, modelVersion, predictionId);
      saved.set(alert.alertType, id);
    }
    for (const resolution of result.resolved) {
      await persistResolution(projectId, resolution.alertType, resolution.reason, asOfAt);
    }

    let notificationsSent = 0;
    if (options.notify !== false && result.notifications.length > 0) {
      const events: NotificationEvent[] = result.notifications.map((alert) => ({
        type: NOTIFICATION_FOR_DECISION[alert.decision] ?? 'ALERT_CREATED',
        projectId,
        alertId: saved.get(alert.alertType),
        alertType: alert.alertType,
        severity: alert.severity,
        recipientIds: alert.responsible.officerId ? [alert.responsible.officerId] : [],
        message: alert.description,
        trigger: alert.trigger,
        recommendedAction: alert.recommendedAction,
        responsibleDepartment: alert.responsible.department,
        occurredAt: result.asOfAt,
      }));
      const outcome = await notificationService.publishAll(events);
      notificationsSent = outcome.published;
    }

    return { ...result, persisted: true, notificationsSent };
  },

  /**
   * Sweeps active projects inside the caller's scope.
   *
   * The scope filter matters here even though the sweep returns only counts: an
   * unscoped sweep would write alerts against, and send notifications about,
   * projects the caller has no authority over.
   */
  async evaluateAll(scope: AccessScope, options: EvaluateOptions = {}) {
    const projects = await prisma.project.findMany({
      where: { AND: [projectScopeWhere(scope), { status: { in: ['ACTIVE', 'ON_HOLD'] } }] },
      select: { id: true },
      take: 1000,
    });
    const runs: Array<{ projectId: string; created: number; escalated: number; notified: number; error?: string }> = [];
    for (const project of projects) {
      try {
        const result = await alertService.evaluate(project.id, options);
        runs.push({
          projectId: project.id,
          created: result.summary.created,
          escalated: result.summary.escalated,
          notified: result.summary.notified,
        });
      } catch (error) {
        // One bad project must not stop the sweep for every other project.
        runs.push({ projectId: project.id, created: 0, escalated: 0, notified: 0, error: (error as Error).message });
      }
    }
    return {
      policyVersion: ALERT_POLICY_VERSION,
      detectorVersion: DETECTOR_VERSION,
      scope: scope.level,
      evaluatedProjects: runs.length,
      created: runs.reduce((total, run) => total + run.created, 0),
      escalated: runs.reduce((total, run) => total + run.escalated, 0),
      notified: runs.reduce((total, run) => total + run.notified, 0),
      failed: runs.filter((run) => run.error).length,
      runs,
    };
  },

  /** Filtered alert list for the queue view, restricted to the caller's scope. */
  async list(scope: AccessScope, query: Record<string, unknown>) {
    const page = Math.max(1, Number(query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize ?? 25)));
    const where: Prisma.AlertWhereInput = {
      ...(nestedProjectScopeWhere(scope) as Prisma.AlertWhereInput),
      ...(typeof query.status === 'string' ? { status: query.status as PrismaStatus } : {}),
      ...(typeof query.severity === 'string' ? { severity: query.severity as PrismaSeverity } : {}),
      ...(typeof query.type === 'string' ? { type: query.type } : {}),
      ...(typeof query.projectId === 'string' ? { projectId: query.projectId } : {}),
      ...(typeof query.assignedToId === 'string' ? { assignedToId: query.assignedToId } : {}),
      ...(query.live === true || query.live === 'true' ? { status: { in: LIVE_STATUSES } } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.alert.findMany({
        where,
        orderBy: [{ severity: 'desc' }, { triggeredAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          project: { select: { projectCode: true, name: true, district: true, state: true, department: true } },
          assignedTo: { select: { id: true, displayName: true, role: true } },
        },
      }),
      prisma.alert.count({ where }),
    ]);
    return { items, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
  },

  /**
   * Notification centre: live alerts grouped by severity, with the counts a
   * badge needs and the oldest unacknowledged item first within each group.
   */
  async notificationCentre(scope: AccessScope, filter: { assignedToId?: string; district?: string } = {}) {
    const where: Prisma.AlertWhereInput = {
      status: { in: LIVE_STATUSES },
      // Scope first, then the caller's own narrowing filters.
      project: { AND: [projectScopeWhere(scope), ...(filter.district ? [{ district: filter.district }] : [])] },
      ...(filter.assignedToId ? { assignedToId: filter.assignedToId } : {}),
    };
    const alerts = await prisma.alert.findMany({
      where,
      orderBy: [{ severity: 'desc' }, { triggeredAt: 'asc' }],
      take: 200,
      include: {
        project: { select: { projectCode: true, name: true, district: true, state: true } },
        assignedTo: { select: { id: true, displayName: true } },
      },
    });

    const bySeverity: Record<AlertSeverity, typeof alerts> = { CRITICAL: [], HIGH: [], WARNING: [], INFO: [] };
    for (const alert of alerts) bySeverity[alert.severity as AlertSeverity].push(alert);

    return {
      generatedAt: new Date().toISOString(),
      policyVersion: ALERT_POLICY_VERSION,
      counts: {
        total: alerts.length,
        unacknowledged: alerts.filter((alert) => alert.status === 'OPEN').length,
        CRITICAL: bySeverity.CRITICAL.length,
        HIGH: bySeverity.HIGH.length,
        WARNING: bySeverity.WARNING.length,
        INFO: bySeverity.INFO.length,
      },
      groups: (['CRITICAL', 'HIGH', 'WARNING', 'INFO'] as AlertSeverity[])
        .map((severity) => ({ severity, alerts: bySeverity[severity] }))
        .filter((group) => group.alerts.length > 0),
    };
  },

  /** Immutable history for one alert, newest first. */
  async history(alertId: string) {
    // The scope check happens in `enforceScope` before this runs.
    const alert = await prisma.alert.findUnique({
      where: { id: alertId },
      include: { project: { select: { projectCode: true, name: true } } },
    });
    if (!alert) throw new AppError(404, 'ALERT_NOT_FOUND', 'Alert was not found');
    const events = await prisma.alertEvent.findMany({
      where: { alertId },
      orderBy: { occurredAt: 'desc' },
      take: 200,
    });
    return {
      alert,
      events: events.map((event) => ({ ...event, id: event.id.toString() })),
      occurrenceCount: alert.occurrenceCount,
      firstTriggeredAt: alert.firstTriggeredAt,
      lastObservedAt: alert.lastObservedAt,
    };
  },

  /** Records an officer acknowledgement, with the note kept on the event. */
  async acknowledge(alertId: string, actorId: string | undefined, note?: string) {
    const existing = await prisma.alert.findUnique({ where: { id: alertId } });
    if (!existing) throw new AppError(404, 'ALERT_NOT_FOUND', 'Alert was not found');
    if (TERMINAL_STATUSES.includes(existing.status)) {
      throw new AppError(409, 'ALERT_NOT_LIVE', `Alert is already ${existing.status.toLowerCase()}`);
    }
    const now = new Date();
    const saved = await prisma.alert.update({
      where: { id: alertId },
      data: { status: 'ACKNOWLEDGED', acknowledgedAt: now, acknowledgedById: actorId ?? null, acknowledgementNote: note ?? null },
    });
    await prisma.alertEvent.create({
      data: {
        alertId,
        eventType: 'ACKNOWLEDGED',
        severityBefore: existing.severity,
        severityAfter: existing.severity,
        statusBefore: existing.status,
        statusAfter: 'ACKNOWLEDGED',
        reason: 'Acknowledged by an authorized official.',
        actorId: actorId ?? null,
        note: note ?? null,
        occurredAt: now,
      },
    });
    await notificationService.publish({
      type: 'ALERT_ACKNOWLEDGED',
      projectId: existing.projectId,
      alertId,
      alertType: existing.type,
      severity: existing.severity as AlertSeverity,
      recipientIds: existing.assignedToId ? [existing.assignedToId] : [],
      message: `Alert ${existing.type} acknowledged.`,
      occurredAt: now.toISOString(),
    });
    return saved;
  },

  /** Officer-set status change: in progress, resolved, or dismissed. */
  async updateStatus(alertId: string, status: string, actorId: string | undefined, note?: string) {
    if (!OFFICER_STATUSES.includes(status as PrismaStatus)) {
      throw new AppError(400, 'INVALID_STATUS', `Status must be one of ${OFFICER_STATUSES.join(', ')}`);
    }
    const existing = await prisma.alert.findUnique({ where: { id: alertId } });
    if (!existing) throw new AppError(404, 'ALERT_NOT_FOUND', 'Alert was not found');
    const next = status as PrismaStatus;
    const now = new Date();
    const saved = await prisma.alert.update({
      where: { id: alertId },
      data: {
        status: next,
        ...(next === 'ACKNOWLEDGED' ? { acknowledgedAt: now, acknowledgedById: actorId ?? null } : {}),
        ...(next === 'RESOLVED' ? { resolvedAt: now, resolutionReason: 'OFFICER_RESOLVED' } : {}),
        ...(next === 'DISMISSED' ? { resolvedAt: now, resolutionReason: 'OFFICER_DISMISSED' } : {}),
        ...(note ? { acknowledgementNote: note } : {}),
      },
    });
    await prisma.alertEvent.create({
      data: {
        alertId,
        eventType: next === 'IN_PROGRESS' ? 'IN_PROGRESS' : next === 'RESOLVED' ? 'RESOLVED' : next === 'DISMISSED' ? 'DISMISSED' : 'ACKNOWLEDGED',
        severityBefore: existing.severity,
        severityAfter: existing.severity,
        statusBefore: existing.status,
        statusAfter: next,
        reason: `Status set to ${next} by an authorized official.`,
        actorId: actorId ?? null,
        note: note ?? null,
        occurredAt: now,
      },
    });
    return saved;
  },

  /** Recent activity across all alerts, for the history view. */
  async recentActivity(scope: AccessScope, limit = 100) {
    const events = await prisma.alertEvent.findMany({
      where: { alert: { project: projectScopeWhere(scope) } },
      orderBy: { occurredAt: 'desc' },
      take: Math.min(500, Math.max(1, limit)),
      include: {
        alert: {
          select: {
            type: true,
            severity: true,
            projectId: true,
            project: { select: { projectCode: true, name: true } },
          },
        },
      },
    });
    return events.map((event) => ({ ...event, id: event.id.toString() }));
  },

  versions: () => ({
    policyVersion: ALERT_POLICY_VERSION,
    detectorVersion: DETECTOR_VERSION,
    severityOrder: SEVERITY_ORDER,
  }),
};
