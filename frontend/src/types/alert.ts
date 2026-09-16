import { z } from 'zod';

/** Mirrors the backend early warning contract. */
export const alertSeveritySchema = z.enum(['INFO', 'WARNING', 'HIGH', 'CRITICAL']);
export const alertStatusSchema = z.enum(['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLVED', 'DISMISSED']);

export const alertTypeSchema = z.enum([
  'MILESTONE_DEADLINE_APPROACHING',
  'MILESTONE_OVERDUE',
  'RISK_TREND_INCREASING',
  'HIGH_DELAY_PROBABILITY',
  'CRITICAL_RISK_LEVEL',
  'RISK_SCORE_JUMP',
  'COMPENSATION_BACKLOG',
  'OBJECTIONS_INCREASING',
  'LEGAL_ISSUE',
  'DOCUMENT_VERIFICATION_BACKLOG',
  'DEPARTMENT_WORKLOAD_OVERLOAD',
]);

export const alertSchema = z.object({
  id: z.string(),
  type: alertTypeSchema,
  severity: alertSeveritySchema,
  status: alertStatusSchema,
  /** Officer-facing description of what was observed. */
  message: z.string(),
  /** The condition expression that fired, with measured value and threshold. */
  trigger: z.string(),
  recommendedAction: z.string(),
  responsibleDepartment: z.string(),
  triggeredAt: z.string(),
  lastObservedAt: z.string().optional(),
  occurrenceCount: z.number().default(1),
  acknowledgedAt: z.string().nullable().default(null),
  assignedTo: z.object({ id: z.string(), displayName: z.string() }).nullable().default(null),
  project: z
    .object({ projectCode: z.string().nullable(), name: z.string().nullable(), district: z.string().nullable() })
    .nullable()
    .default(null),
});

export const notificationCentreSchema = z.object({
  generatedAt: z.string(),
  counts: z.object({
    total: z.number(),
    unacknowledged: z.number(),
    CRITICAL: z.number(),
    HIGH: z.number(),
    WARNING: z.number(),
    INFO: z.number(),
  }),
  groups: z.array(z.object({ severity: alertSeveritySchema, alerts: z.array(alertSchema) })),
});

export type AlertSeverity = z.infer<typeof alertSeveritySchema>;
export type Alert = z.infer<typeof alertSchema>;
export type NotificationCentre = z.infer<typeof notificationCentreSchema>;

/** Officer-facing labels. The stored value stays the stable machine code. */
export const ALERT_TYPE_LABELS: Record<z.infer<typeof alertTypeSchema>, string> = {
  MILESTONE_DEADLINE_APPROACHING: 'Milestone deadline approaching',
  MILESTONE_OVERDUE: 'Milestone overdue',
  RISK_TREND_INCREASING: 'Risk rising across recent predictions',
  HIGH_DELAY_PROBABILITY: 'High predicted delay probability',
  CRITICAL_RISK_LEVEL: 'Critical risk classification',
  RISK_SCORE_JUMP: 'Sudden risk score increase',
  COMPENSATION_BACKLOG: 'Compensation backlog',
  OBJECTIONS_INCREASING: 'Unresolved objections increasing',
  LEGAL_ISSUE: 'Legal issue recorded',
  DOCUMENT_VERIFICATION_BACKLOG: 'Document verification backlog',
  DEPARTMENT_WORKLOAD_OVERLOAD: 'Department workload overloaded',
};
