/**
 * Request validation.
 *
 * Every route validates its params, query, and body here before a handler runs.
 * Bodies are strict, so an unexpected field is refused rather than silently
 * dropped: silent stripping hides a client bug, and it hides an attacker probing
 * for a field the server might accept.
 *
 * Text fields are length-bounded and reject control characters, which keeps
 * terminal escape sequences and newlines out of stored values, log lines, and
 * anything later rendered.
 */

import { z } from 'zod';

const id = z.string().uuid();

/** Matches any C0 control character or DEL. */
const CONTROL_CHARACTERS = new RegExp('[\\u0000-\\u001f\\u007f]');

/** Printable text with no control characters, no newlines, and no null bytes. */
const safeText = (max: number, min = 1) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((value) => !CONTROL_CHARACTERS.test(value), 'Text must not contain control characters');

/**
 * A geographic or departmental identifier, compared against project columns.
 *
 * `\p{M}` matters: Indic scripts write vowels as combining marks, so a pattern
 * of letters and numbers alone rejects ordinary place names such as लुधियाना.
 */
const identifier = (max = 120) =>
  safeText(max, 2).refine(
    (value) => /^[\p{L}\p{M}\p{N} .,'()&/-]+$/u.test(value),
    'Identifier contains unsupported characters',
  );

/**
 * Passwords are hashed with bcrypt and never stored or logged in plaintext.
 * Length is the control that matters most; a modest composition rule catches the
 * weakest choices without pushing people towards predictable substitutions.
 */
const password = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(200)
  .refine((value) => !/\s{4,}/.test(value), 'Password must not be mostly whitespace')
  .refine(
    (value) => /[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value),
    'Password must combine lower case, upper case, and digits',
  );

const pageQuery = z.object({
  page: z.coerce.number().int().positive().max(10_000).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  search: safeText(120).optional(),
  status: safeText(40).optional(),
  sort: safeText(40).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

export const idParam = z.object({ params: z.object({ id }), query: z.any(), body: z.any() });
export const projectList = z.object({ params: z.any(), body: z.any(), query: pageQuery });

// --- Projects ----------------------------------------------------------------

const projectFields = z
  .object({
    projectCode: safeText(80, 2),
    name: safeText(240, 2),
    state: identifier(),
    district: identifier(),
    department: identifier(),
    projectType: safeText(100, 2),
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
    plannedStartDate: z.coerce.date(),
    targetDate: z.coerce.date(),
    dataOrigin: z.enum(['REAL', 'SYNTHETIC_DEMO', 'USER_ENTERED', 'IMPORTED']).default('USER_ENTERED'),
  })
  .strict();

export const projectCreate = z.object({
  params: z.any(),
  query: z.any(),
  body: projectFields.refine((value) => value.targetDate >= value.plannedStartDate, {
    message: 'targetDate must not precede plannedStartDate',
    path: ['targetDate'],
  }),
});

export const projectUpdate = z.object({
  params: z.object({ id }),
  query: z.any(),
  // `state`, `district`, and `department` stay updatable, but a change to any of
  // them is re-checked against the caller's scope by `enforceScopeOnBody`.
  body: projectFields.partial().strict(),
});

// --- Cases (milestone-level case records) ------------------------------------

const milestoneFields = z
  .object({
    name: safeText(200, 2),
    plannedAt: z.coerce.date(),
    ownerDept: identifier().optional(),
    status: z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'OVERDUE', 'CANCELLED']).optional(),
  })
  .strict();

export const milestoneCreate = z.object({ params: z.object({ id }), query: z.any(), body: milestoneFields });
export const milestoneUpdate = z.object({
  params: z.object({ id }),
  query: z.any(),
  body: milestoneFields.partial().strict(),
});

// --- Documents ---------------------------------------------------------------

/**
 * Document types are an allow-list, not free text. An open field becomes a
 * dumping ground and makes downstream handling of a "document" unpredictable.
 */
export const DOCUMENT_TYPES = [
  'TITLE_DEED',
  'MUTATION_RECORD',
  'SURVEY_PLAN',
  'ENCUMBRANCE_CERTIFICATE',
  'OBJECTION_FILING',
  'HEARING_ORDER',
  'AWARD_STATEMENT',
  'COMPENSATION_VOUCHER',
  'PAYMENT_PROOF',
  'POSSESSION_CERTIFICATE',
  'LEGAL_NOTICE',
  'COURT_ORDER',
  'IDENTITY_PROOF',
  'OTHER',
] as const;

/**
 * An object-store key, not a filesystem path.
 *
 * Rejects traversal, absolute paths, backslashes, and anything resembling a
 * scheme or a host, so a stored key can never be resolved against the local
 * filesystem or turned into an outbound request.
 */
const storageKey = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, 'Storage key contains unsupported characters')
  .refine((value) => !value.includes('..'), 'Storage key must not traverse directories')
  .refine((value) => !value.includes('//'), 'Storage key must not contain empty path segments')
  .refine((value) => !/^[a-z][a-z0-9+.-]*:/i.test(value), 'Storage key must not contain a URI scheme');

const checksumSha256 = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-f0-9]{64}$/, 'Checksum must be a hex-encoded SHA-256 digest');

export const documentCreate = z.object({
  params: z.any(),
  query: z.any(),
  body: z
    .object({
      projectId: id,
      documentType: z.enum(DOCUMENT_TYPES),
      documentReference: safeText(160).optional(),
      status: z.enum(['REQUIRED', 'SUBMITTED', 'VERIFIED', 'REJECTED', 'EXPIRED']).default('SUBMITTED'),
      storageKey: storageKey.optional(),
      checksumSha256: checksumSha256.optional(),
    })
    .strict()
    // A stored object without a digest cannot be shown to be the object that was
    // reviewed, so the two travel together or not at all.
    .refine((value) => !value.storageKey || Boolean(value.checksumSha256), {
      message: 'checksumSha256 is required when storageKey is supplied',
      path: ['checksumSha256'],
    }),
});

// --- Predictions -------------------------------------------------------------

export const predictionCreate = z.object({
  params: z.any(),
  query: z.any(),
  body: z
    .object({
      projectId: id,
      asOfAt: z.coerce.date().optional(),
      horizonDays: z.number().int().positive().max(365).default(90),
      forceRefresh: z.boolean().default(false),
    })
    .strict(),
});

export const acknowledge = z.object({
  params: z.object({ id }),
  query: z.any(),
  body: z.object({ note: safeText(500).optional() }).strict(),
});

export const login = z.object({
  params: z.any(),
  query: z.any(),
  // The login password is compared, not stored, so it is not strength-checked
  // here. Bounds exist only to keep an oversized value away from the hasher.
  body: z
    .object({ email: z.string().trim().toLowerCase().email().max(254), password: z.string().min(1).max(200) })
    .strict(),
});

// --- Recommendations ---------------------------------------------------------

const evidenceMetrics = z
  .object({
    parcelCount: z.number().nonnegative().max(1_000_000).optional(),
    affectedLandownerCount: z.number().nonnegative().max(1_000_000).optional(),
    unresolvedRecordCount: z.number().nonnegative().max(1_000_000).optional(),
    disputedOwnershipFlag: z.boolean().optional(),
    objectionCount: z.number().nonnegative().max(1_000_000).optional(),
    unresolvedObjectionCount: z.number().nonnegative().max(1_000_000).optional(),
    requiredDocumentCount: z.number().nonnegative().max(100_000).optional(),
    missingDocumentCount: z.number().nonnegative().max(100_000).optional(),
    invalidDocumentCount: z.number().nonnegative().max(100_000).optional(),
    documentVerificationPendingCount: z.number().nonnegative().max(100_000).optional(),
    pendingApprovalCount: z.number().nonnegative().max(100_000).optional(),
    blockedDependencyCount: z.number().nonnegative().max(100_000).optional(),
    pendingCompensationAmount: z.number().nonnegative().max(1e15).optional(),
    compensationApprovalPendingFlag: z.boolean().optional(),
    paymentProcessingDays: z.number().nonnegative().max(36_500).optional(),
    openLegalCaseCount: z.number().nonnegative().max(100_000).optional(),
    legalDisputeFlag: z.boolean().optional(),
    stayOrderFlag: z.boolean().optional(),
    daysInCurrentStage: z.number().nonnegative().max(36_500).optional(),
    averageStageDurationDays: z.number().positive().max(36_500).optional(),
    overdueDays: z.number().nonnegative().max(36_500).optional(),
    milestoneSlippageCount: z.number().nonnegative().max(10_000).optional(),
    daysSinceLastUpdate: z.number().nonnegative().max(36_500).optional(),
  })
  .strict();

const pendingTask = z
  .object({
    taskCode: safeText(80, 2),
    label: safeText(200).optional(),
    count: z.number().nonnegative().max(1_000_000),
    unit: safeText(40).optional(),
    ownerDepartment: identifier(160).nullable().optional(),
    oldestAgeDays: z.number().nonnegative().max(36_500).optional(),
    dueAt: z.coerce.date().nullable().optional(),
  })
  .strict();

const departmentWorkload = z
  .object({
    department: identifier(160),
    workloadIndex: z.number().min(0).max(5),
    openItems: z.number().nonnegative().max(1_000_000).optional(),
    activeProjects: z.number().nonnegative().max(100_000).optional(),
    observedAt: z.coerce.date().optional(),
  })
  .strict();

const evidenceOutcomeRate = z
  .object({
    delayRateWhenPresent: z.number().min(0).max(1),
    delayRateWhenAbsent: z.number().min(0).max(1),
    sampleSize: z.number().int().nonnegative().max(10_000_000),
  })
  .strict();

const historicalPatterns = z
  .object({
    departmentDelayRate: z.number().min(0).max(1).optional(),
    districtDelayRate: z.number().min(0).max(1).optional(),
    projectTypeDelayRate: z.number().min(0).max(1).optional(),
    averageStageDurationDays: z.number().positive().max(36_500).optional(),
    evidenceOutcomeRates: z.record(safeText(80, 2), evidenceOutcomeRate).optional(),
    medianResolutionDays: z.record(safeText(80, 2), z.number().nonnegative().max(36_500)).optional(),
    observedAt: z.coerce.date().optional(),
  })
  .strict();

const riskFactor = z
  .object({
    factorCode: safeText(120, 2),
    label: safeText(200).optional(),
    direction: z.enum(['INCREASES_RISK', 'REDUCES_RISK', 'NEUTRAL']).optional(),
    relativeContribution: z.number().min(0).max(1).optional(),
    currentValue: z.number().nullable().optional(),
    comparisonValue: z.number().nullable().optional(),
    source: z.enum(['ML', 'RULE', 'ML_AND_RULE']).optional(),
    evidenceAt: z.coerce.date().optional(),
    explanation: safeText(600).optional(),
  })
  .strict();

export const recommendationGenerate = z.object({
  params: z.object({ id }),
  query: z.any(),
  body: z
    .object({
      horizonDays: z.number().int().positive().max(365).default(90),
      asOfAt: z.coerce.date().optional(),
      persist: z.boolean().default(true),
      snapshot: z
        .object({
          metrics: evidenceMetrics.optional(),
          pendingTasks: z.array(pendingTask).max(50).optional(),
          departmentWorkload: z.array(departmentWorkload).max(100).optional(),
          historicalPatterns: historicalPatterns.optional(),
          topRiskFactors: z.array(riskFactor).max(50).optional(),
        })
        .strict()
        .optional(),
    })
    .strict()
    .default({ horizonDays: 90, persist: true }),
});

export const recommendationStatus = z.object({
  params: z.object({ id }),
  query: z.any(),
  body: z
    .object({
      status: z.enum(['OPEN', 'ACKNOWLEDGED', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'DISMISSED', 'EXPIRED']),
    })
    .strict(),
});

// --- Alerts ------------------------------------------------------------------

const predictionHistoryPoint = z
  .object({
    predictedAt: z.coerce.date(),
    delayProbability: z.number().min(0).max(1),
    riskScore: z.number().min(0).max(1).optional(),
    riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
    predictionId: safeText(120).optional(),
  })
  .strict();

const observationHistoryPoint = z.object({ observedAt: z.coerce.date(), metrics: evidenceMetrics }).strict();

export const alertEvaluate = z.object({
  params: z.object({ id }),
  query: z.any(),
  body: z
    .object({
      asOfAt: z.coerce.date().optional(),
      horizonDays: z.number().int().positive().max(365).default(90),
      persist: z.boolean().default(true),
      notify: z.boolean().default(true),
      snapshot: z
        .object({
          metrics: evidenceMetrics.optional(),
          departmentWorkload: z.array(departmentWorkload).max(100).optional(),
          predictionHistory: z.array(predictionHistoryPoint).max(200).optional(),
          observationHistory: z.array(observationHistoryPoint).max(200).optional(),
        })
        .strict()
        .optional(),
    })
    .strict()
    .default({ horizonDays: 90, persist: true, notify: true }),
});

export const alertEvaluateAll = z.object({
  params: z.any(),
  query: z.any(),
  body: z
    .object({ persist: z.boolean().default(true), notify: z.boolean().default(true) })
    .strict()
    .default({ persist: true, notify: true }),
});

export const alertList = z.object({
  params: z.any(),
  body: z.any(),
  query: z.object({
    page: z.coerce.number().int().positive().max(10_000).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
    status: z.enum(['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLVED', 'DISMISSED']).optional(),
    severity: z.enum(['INFO', 'WARNING', 'HIGH', 'CRITICAL']).optional(),
    type: safeText(100).optional(),
    projectId: id.optional(),
    assignedToId: id.optional(),
    live: z.enum(['true', 'false']).optional(),
  }),
});

export const alertStatus = z.object({
  params: z.object({ id }),
  query: z.any(),
  body: z
    .object({
      status: z.enum(['ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLVED', 'DISMISSED']),
      note: safeText(500).optional(),
    })
    .strict(),
});

// --- Users and audit ---------------------------------------------------------

const roleEnum = z.enum(['SUPER_ADMIN', 'STATE_ADMIN', 'DISTRICT_OFFICER', 'PROJECT_OFFICER', 'ANALYST', 'VIEWER']);

export const userList = z.object({
  params: z.any(),
  body: z.any(),
  query: z.object({
    page: z.coerce.number().int().positive().max(10_000).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
    role: roleEnum.optional(),
    active: z.enum(['true', 'false']).optional(),
  }),
});

export const userCreate = z.object({
  params: z.any(),
  query: z.any(),
  body: z
    .object({
      email: z.string().trim().toLowerCase().email().max(254),
      password,
      displayName: safeText(180, 2),
      role: roleEnum,
      stateCode: identifier().optional(),
      districtCode: identifier().optional(),
      department: identifier().optional(),
    })
    .strict()
    .refine(
      (value) => {
        const localPart = value.email.split('@')[0];
        return !localPart || !value.password.toLowerCase().includes(localPart.toLowerCase());
      },
      { message: 'Password must not contain the account name', path: ['password'] },
    ),
});

export const userUpdate = z.object({
  params: z.object({ id }),
  query: z.any(),
  body: z
    .object({
      displayName: safeText(180, 2).optional(),
      role: roleEnum.optional(),
      stateCode: identifier().optional(),
      districtCode: identifier().optional(),
      department: identifier().optional(),
      active: z.boolean().optional(),
    })
    .strict(),
});

export const auditLogList = z.object({
  params: z.any(),
  body: z.any(),
  query: z.object({
    page: z.coerce.number().int().positive().max(10_000).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
    action: safeText(60).optional(),
    resource: safeText(40).optional(),
    outcome: z.enum(['SUCCESS', 'DENIED', 'FAILED']).optional(),
    actorId: id.optional(),
    resourceId: id.optional(),
  }),
});
