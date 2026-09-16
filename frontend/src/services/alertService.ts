import { apiGet, apiSend } from '../api/client';
import {
  alertSchema,
  notificationCentreSchema,
  type Alert,
  type AlertSeverity,
  type NotificationCentre,
} from '../types/alert';
import { projects, type Project } from '../data';

const SEVERITY_ORDER: Record<AlertSeverity, number> = { INFO: 0, WARNING: 1, HIGH: 2, CRITICAL: 3 };

/**
 * Demo alerts, derived from the same project records the registry displays.
 *
 * This is the fallback for when the API is unreachable. It applies the same
 * thresholds as the backend detectors to values already on screen, so the queue
 * stays checkable against the project rows rather than being invented.
 */
const demoAlerts = (): Alert[] => {
  const alerts: Alert[] = [];
  const now = Date.now();

  const push = (
    project: Project,
    type: Alert['type'],
    severity: AlertSeverity,
    message: string,
    trigger: string,
    recommendedAction: string,
    responsibleDepartment: string,
    ageHours: number,
  ) => {
    alerts.push({
      id: `demo_${project.id}_${type}`,
      type,
      severity,
      status: 'OPEN',
      message,
      trigger,
      recommendedAction,
      responsibleDepartment,
      triggeredAt: new Date(now - ageHours * 3_600_000).toISOString(),
      lastObservedAt: new Date(now).toISOString(),
      occurrenceCount: 1,
      acknowledgedAt: null,
      assignedTo: null,
      project: { projectCode: project.id, name: project.name, district: project.district },
    });
  };

  projects.forEach((project, index) => {
    if (project.risk === 'CRITICAL') {
      push(
        project,
        'CRITICAL_RISK_LEVEL',
        'CRITICAL',
        `The project is classified CRITICAL risk, with a predicted delay probability of ${project.probability}.`,
        `risk_level = CRITICAL (governed classification)`,
        'Escalate to the district review and confirm an owner and date for every open critical action.',
        project.department,
        2 + index,
      );
    } else if (project.probability >= 0.75) {
      push(
        project,
        'HIGH_DELAY_PROBABILITY',
        'HIGH',
        `Predicted delay probability is ${project.probability} over the reporting horizon.`,
        `delay_probability = ${project.probability} >= 0.75 (HIGH rung)`,
        'Review the ranked recommendations and confirm an owner for the highest-priority open action.',
        project.department,
        4 + index,
      );
    } else if (project.probability >= 0.6) {
      push(
        project,
        'HIGH_DELAY_PROBABILITY',
        'WARNING',
        `Predicted delay probability is ${project.probability} over the reporting horizon.`,
        `delay_probability = ${project.probability} >= 0.6 (WARNING rung)`,
        'Review the ranked recommendations for this project at the next cycle.',
        project.department,
        6 + index,
      );
    }

    if (/overdue/i.test(project.factor)) {
      const overdue = Number(project.factor.match(/\d+/)?.[0] ?? 21);
      push(
        project,
        'MILESTONE_OVERDUE',
        overdue >= 45 ? 'CRITICAL' : overdue >= 21 ? 'HIGH' : 'WARNING',
        `Milestone "${project.stage}" is ${overdue} day(s) past its planned date.`,
        `milestone_overdue_days = ${overdue} >= ${overdue >= 45 ? 45 : overdue >= 21 ? 21 : 7} rung`,
        `Assign an accountable officer to milestone "${project.stage}" and agree a revised completion date.`,
        project.department,
        8 + index,
      );
    }

    if (project.objections >= 12) {
      push(
        project,
        'OBJECTIONS_INCREASING',
        project.objections >= 18 ? 'HIGH' : 'WARNING',
        `${project.objections} landowner objections remain unresolved on this acquisition.`,
        `unresolved_objection_count = ${project.objections}`,
        'Schedule hearings for the unresolved objections and assign a reviewing officer to each.',
        'Land Acquisition Cell',
        10 + index,
      );
    }

    if (/pending/i.test(project.compensation)) {
      push(
        project,
        'COMPENSATION_BACKLOG',
        'WARNING',
        `Compensation of ${project.compensation} is recorded as outstanding.`,
        `compensation_approval_pending_flag = true with ${project.compensation} outstanding`,
        'Escalate the ageing compensation cases to the departmental payment review.',
        'Finance and Compensation Department',
        12 + index,
      );
    }

    if (/open matter/i.test(project.legal)) {
      const cases = Number(project.legal.match(/\d+/)?.[0] ?? 1);
      push(
        project,
        'LEGAL_ISSUE',
        cases >= 4 ? 'HIGH' : cases >= 2 ? 'WARNING' : 'INFO',
        `${cases} legal case(s) are open against this acquisition.`,
        `open_legal_case_count = ${cases} >= ${cases >= 4 ? 4 : cases >= 2 ? 2 : 1} rung`,
        'Assign legal representation and record a hearing calendar for the open matters.',
        'Legal Department',
        14 + index,
      );
    }
  });

  return alerts.sort(
    (left, right) =>
      SEVERITY_ORDER[right.severity] - SEVERITY_ORDER[left.severity] ||
      Date.parse(left.triggeredAt) - Date.parse(right.triggeredAt),
  );
};

const groupBySeverity = (alerts: Alert[]): NotificationCentre => {
  const severities: AlertSeverity[] = ['CRITICAL', 'HIGH', 'WARNING', 'INFO'];
  const counts = { total: alerts.length, unacknowledged: alerts.filter((alert) => alert.status === 'OPEN').length, CRITICAL: 0, HIGH: 0, WARNING: 0, INFO: 0 };
  for (const alert of alerts) counts[alert.severity] += 1;
  return {
    generatedAt: new Date().toISOString(),
    counts,
    groups: severities
      .map((severity) => ({ severity, alerts: alerts.filter((alert) => alert.severity === severity) }))
      .filter((group) => group.alerts.length > 0),
  };
};

export async function getNotificationCentre(): Promise<{ centre: NotificationCentre; live: boolean }> {
  try {
    return { centre: await apiGet('/notifications', notificationCentreSchema), live: true };
  } catch {
    return { centre: groupBySeverity(demoAlerts()), live: false };
  }
}

export async function acknowledgeAlert(alertId: string, note?: string): Promise<Alert | null> {
  try {
    return await apiSend('POST', `/alerts/${alertId}/acknowledge`, { note }, alertSchema.partial().passthrough() as never);
  } catch {
    // Demo mode: the page records the acknowledgement locally.
    return null;
  }
}
