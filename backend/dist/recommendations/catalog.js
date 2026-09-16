/**
 * Evidence-to-action catalogue.
 *
 * Every recommendation the engine can ever produce is defined here. An entry
 * only fires when its `extract` function finds a measured value in the supplied
 * inputs, so no action can be generated without evidence behind it.
 */
import { CODE_POLICY, baselineRatioSeverity, clamp, flagSeverity, ratioSeverity, sigmoidSeverity } from './policy.js';
import { ASSOCIATION_CLAUSE, formatCount } from './wording.js';
// ---------------------------------------------------------------------------
// Input accessors
// ---------------------------------------------------------------------------
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
/**
 * Resolves a measured count, preferring the operational pending-task queue over
 * the stored project metric. Returns the value and which input block it came
 * from, so the emitted evidence can name its own source.
 */
const resolveCount = (context, taskCode, metricValue) => {
    const task = context.pendingTaskByCode.get(taskCode);
    if (task && isNumber(task.count))
        return { value: task.count, source: 'PENDING_TASKS', task };
    if (isNumber(metricValue))
        return { value: metricValue, source: 'PROJECT_DATA' };
    return null;
};
const unitFor = (task, fallback) => task?.unit ?? fallback;
const departmentFrom = (context, taskCode, fallbackName, fallbackBasis) => {
    const task = context.pendingTaskByCode.get(taskCode);
    if (task?.ownerDepartment) {
        return { name: task.ownerDepartment, basis: `Recorded owner of the ${taskCode} pending-task queue.` };
    }
    return { name: fallbackName, basis: fallbackBasis };
};
const milestoneOwnerOrProject = (context) => {
    const owner = context.milestone?.ownerDepartment;
    if (owner)
        return { name: owner, basis: 'Recorded owner department of the current milestone.' };
    return { name: context.project.department, basis: 'Owning department of the project; no milestone owner is recorded.' };
};
const medianResolution = (patterns, code) => {
    const value = patterns?.medianResolutionDays?.[code];
    return isNumber(value) ? value : null;
};
/** Optional clause reporting how long comparable cases took to clear the item. */
const historicalClause = (context, code) => {
    const median = medianResolution(context.historicalPatterns, code);
    return median === null
        ? ''
        : ` Comparable completed cases cleared this item in a median of ${median} days.`;
};
// ---------------------------------------------------------------------------
// Observation builder
// ---------------------------------------------------------------------------
export const buildObservation = (entry, partial, context) => ({
    code: entry.code,
    label: entry.label,
    measuredValue: partial.measuredValue,
    unit: partial.unit,
    comparisonValue: partial.comparisonValue ?? null,
    threshold: CODE_POLICY[entry.code].threshold,
    severity: clamp(partial.severity),
    severityFunction: partial.severityFunction,
    source: partial.source,
    observedAt: context.asOfAt.toISOString(),
    featureCodes: partial.featureCodes ?? entry.featureCodes,
    description: partial.description,
});
// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------
export const CATALOG = [
    {
        code: 'ACTIVE_STAY_ORDER',
        label: 'Active stay order on the acquisition',
        featureCodes: ['stay_order_flag'],
        linkedFactorCodes: ['STAY_ORDER_FLAG', 'ACTIVE_STAY_ORDER'],
        impactCategory: 'LEGAL_CONSTRAINT',
        extract: (context) => {
            if (context.metrics.stayOrderFlag !== true)
                return null;
            return {
                measuredValue: 1,
                unit: 'order',
                severity: flagSeverity(true),
                severityFunction: 'flagSeverity(stay_order_flag)',
                source: 'PROJECT_DATA',
                description: 'A stay order is recorded as active against this acquisition.',
            };
        },
        department: () => ({ name: 'Legal Department', basis: 'Statutory owner of stay-order and court matters.' }),
        action: () => 'Refer the active stay order to the legal department for review of the current position and next hearing, and hold any acquisition step that the order restrains.',
        reason: () => `A stay order is recorded as active against this acquisition, and an active stay ${ASSOCIATION_CLAUSE}. Legal referral is recommended because the order governs which acquisition steps may lawfully proceed.`,
        impact: () => 'May clarify the permitted scope of work and could help mitigate the risk of an acquisition step being taken contrary to the order.',
    },
    {
        code: 'OWNERSHIP_UNRESOLVED',
        label: 'Unresolved ownership or title records',
        featureCodes: ['unresolved_record_count', 'disputed_ownership_flag', 'ownership_complexity_score'],
        linkedFactorCodes: [
            'UNRESOLVED_RECORD_COUNT',
            'OWNERSHIP_UNRESOLVED',
            'OWNERSHIP_COMPLEXITY_SCORE',
            'DISPUTED_OWNERSHIP_FLAG',
            'AFFECTED_LANDOWNER_COUNT',
        ],
        impactCategory: 'ADMINISTRATIVE_BOTTLENECK',
        extract: (context) => {
            const resolved = resolveCount(context, 'OWNERSHIP_UNRESOLVED', context.metrics.unresolvedRecordCount);
            if (!resolved || resolved.value <= 0)
                return null;
            const threshold = CODE_POLICY.OWNERSHIP_UNRESOLVED.threshold;
            return {
                measuredValue: resolved.value,
                unit: unitFor(resolved.task, 'parcel'),
                comparisonValue: context.metrics.parcelCount ?? null,
                severity: ratioSeverity(resolved.value, threshold),
                severityFunction: `ratioSeverity(unresolved_record_count=${resolved.value}, threshold=${threshold})`,
                source: resolved.source,
                description: `Ownership verification is incomplete for ${formatCount(resolved.value, unitFor(resolved.task, 'parcel'))}.`,
            };
        },
        department: (context) => departmentFrom(context, 'OWNERSHIP_UNRESOLVED', 'Land Records Department', 'Statutory custodian of title and mutation records.'),
        action: (evidence) => `Complete ownership verification for the ${formatCount(evidence.measuredValue, evidence.unit)} with unresolved records.`,
        reason: (evidence, context) => `Ownership verification is currently incomplete for ${formatCount(evidence.measuredValue, evidence.unit)} and ${ASSOCIATION_CLAUSE}.${historicalClause(context, 'OWNERSHIP_UNRESOLVED')}`,
        impact: () => 'May reduce the administrative bottleneck in title verification and could help mitigate downstream compensation and possession delays.',
    },
    {
        code: 'COMPENSATION_PENDING',
        label: 'Compensation pending beyond the departmental window',
        featureCodes: ['payment_processing_days', 'pending_compensation_amount', 'compensation_approval_pending_flag'],
        linkedFactorCodes: [
            'PAYMENT_PROCESSING_DAYS',
            'PENDING_COMPENSATION_AMOUNT',
            'COMPENSATION_APPROVAL_PENDING_FLAG',
            'COMPENSATION_PENDING_DAYS',
            'COMPENSATION_PENDING',
        ],
        impactCategory: 'FINANCIAL_DEPENDENCY',
        extract: (context) => {
            const task = context.pendingTaskByCode.get('COMPENSATION_PENDING');
            const ageDays = isNumber(context.metrics.paymentProcessingDays)
                ? context.metrics.paymentProcessingDays
                : isNumber(task?.oldestAgeDays)
                    ? task.oldestAgeDays
                    : null;
            const pendingAmount = context.metrics.pendingCompensationAmount;
            const approvalPending = context.metrics.compensationApprovalPendingFlag === true;
            if (ageDays === null && !approvalPending)
                return null;
            if (ageDays === null) {
                return {
                    measuredValue: isNumber(pendingAmount) ? pendingAmount : 1,
                    unit: isNumber(pendingAmount) ? 'currency unit' : 'pending approval',
                    severity: 0.5,
                    severityFunction: 'policySeverity(compensation_approval_pending_flag=true, no ageing data)',
                    source: 'PROJECT_DATA',
                    description: 'Compensation approval is recorded as pending; no payment ageing value is available.',
                    featureCodes: ['compensation_approval_pending_flag', 'pending_compensation_amount'],
                };
            }
            const threshold = CODE_POLICY.COMPENSATION_PENDING.threshold;
            return {
                measuredValue: ageDays,
                unit: 'day',
                comparisonValue: threshold,
                severity: sigmoidSeverity(ageDays, threshold, threshold / 3),
                severityFunction: `sigmoidSeverity(payment_processing_days=${ageDays}, tolerance=${threshold}, scale=${(threshold / 3).toFixed(1)})`,
                source: task ? 'PENDING_TASKS' : 'PROJECT_DATA',
                description: `Compensation has been in processing for ${formatCount(ageDays, 'day')} against a departmental window of ${threshold} days.`,
            };
        },
        department: (context) => departmentFrom(context, 'COMPENSATION_PENDING', 'Finance and Compensation Department', 'Statutory owner of compensation assessment and disbursement.'),
        action: (evidence) => evidence.unit === 'day'
            ? `Escalate compensation cases in processing beyond ${CODE_POLICY.COMPENSATION_PENDING.threshold} days to the departmental payment review.`
            : 'Route the pending compensation approval to the authorized sanctioning officer.',
        reason: (evidence, context) => evidence.unit === 'day'
            ? `Compensation has been in processing for ${formatCount(evidence.measuredValue, 'day')}, beyond the ${CODE_POLICY.COMPENSATION_PENDING.threshold}-day departmental window, and prolonged payment processing ${ASSOCIATION_CLAUSE}.${historicalClause(context, 'COMPENSATION_PENDING')}`
            : `Compensation approval is recorded as pending, and an open compensation approval ${ASSOCIATION_CLAUSE}. Escalation is recommended because the payment dependency remains open.`,
        impact: () => 'May reduce the financial dependency holding the case open and could help mitigate delay in reaching possession.',
    },
    {
        code: 'PENDING_APPROVAL_COUNT',
        label: 'Approvals pending in the queue',
        featureCodes: ['pending_approval_count', 'approval_stage_count'],
        linkedFactorCodes: ['PENDING_APPROVAL_COUNT', 'PENDING_APPROVAL', 'APPROVAL_STAGE_COUNT'],
        impactCategory: 'ADMINISTRATIVE_BOTTLENECK',
        extract: (context) => {
            const resolved = resolveCount(context, 'PENDING_APPROVAL_COUNT', context.metrics.pendingApprovalCount);
            if (!resolved || resolved.value <= 0)
                return null;
            const threshold = CODE_POLICY.PENDING_APPROVAL_COUNT.threshold;
            return {
                measuredValue: resolved.value,
                unit: unitFor(resolved.task, 'approval'),
                comparisonValue: threshold,
                severity: ratioSeverity(resolved.value, threshold),
                severityFunction: `ratioSeverity(pending_approval_count=${resolved.value}, threshold=${threshold})`,
                source: resolved.source,
                description: `${formatCount(resolved.value, 'approval')} remain pending in the queue.`,
            };
        },
        department: (context) => departmentFrom(context, 'PENDING_APPROVAL_COUNT', context.project.department, 'Owning department of the project approval queue.'),
        action: (evidence) => `Route the ${formatCount(evidence.measuredValue, 'pending approval')} to the authorized decision-maker and confirm a decision date for each.`,
        reason: (evidence, context) => `${formatCount(evidence.measuredValue, 'approval')} remain pending against a review threshold of ${evidence.threshold}, and an ageing approval queue ${ASSOCIATION_CLAUSE}.${historicalClause(context, 'PENDING_APPROVAL_COUNT')}`,
        impact: () => 'May reduce the administrative bottleneck in the approval queue and could help mitigate stage stagnation.',
    },
    {
        code: 'MILESTONE_OVERDUE',
        label: 'Current milestone overdue',
        featureCodes: ['overdue_days', 'milestone.planned_at'],
        linkedFactorCodes: ['OVERDUE_DAYS', 'STAGE_OVERDUE_DAYS', 'MILESTONE_OVERDUE'],
        impactCategory: 'SCHEDULE_RECOVERY',
        extract: (context) => {
            const overdue = context.milestoneOverdueDays;
            if (overdue === null || overdue <= 0)
                return null;
            const threshold = CODE_POLICY.MILESTONE_OVERDUE.threshold;
            return {
                measuredValue: overdue,
                unit: 'day',
                comparisonValue: threshold,
                severity: sigmoidSeverity(overdue, threshold, threshold / 3),
                severityFunction: `sigmoidSeverity(overdue_days=${overdue}, tolerance=${threshold}, scale=${(threshold / 3).toFixed(1)})`,
                source: context.milestone ? 'MILESTONE' : 'PROJECT_DATA',
                description: `The current milestone is ${formatCount(overdue, 'day')} past its planned date.`,
            };
        },
        department: milestoneOwnerOrProject,
        action: (_evidence, context) => `Assign an accountable officer to the milestone "${context.milestone?.name ?? 'current milestone'}" and agree a revised completion date at the next review.`,
        reason: (evidence, context) => {
            const name = context.milestone?.name ? `"${context.milestone.name}"` : 'The current milestone';
            return `Milestone ${name} is ${formatCount(evidence.measuredValue, 'day')} past its planned date, and milestone overdue age ${ASSOCIATION_CLAUSE}.${historicalClause(context, 'MILESTONE_OVERDUE')}`;
        },
        impact: () => 'May restore schedule ownership for the open milestone and could help mitigate further slippage into the next stage.',
    },
    {
        code: 'OPEN_OBJECTION_COUNT',
        label: 'Unresolved landowner objections',
        featureCodes: ['unresolved_objection_count', 'objection_count', 'hearing_count'],
        linkedFactorCodes: ['UNRESOLVED_OBJECTION_COUNT', 'OBJECTION_COUNT', 'OPEN_OBJECTION_COUNT', 'HEARING_COUNT'],
        impactCategory: 'STAKEHOLDER_RESOLUTION',
        extract: (context) => {
            const resolved = resolveCount(context, 'OPEN_OBJECTION_COUNT', context.metrics.unresolvedObjectionCount ?? context.metrics.objectionCount);
            if (!resolved || resolved.value <= 0)
                return null;
            const threshold = CODE_POLICY.OPEN_OBJECTION_COUNT.threshold;
            return {
                measuredValue: resolved.value,
                unit: unitFor(resolved.task, 'objection'),
                comparisonValue: context.metrics.objectionCount ?? threshold,
                severity: ratioSeverity(resolved.value, threshold),
                severityFunction: `ratioSeverity(unresolved_objection_count=${resolved.value}, threshold=${threshold})`,
                source: resolved.source,
                description: `${formatCount(resolved.value, 'objection')} from landowners remain unresolved.`,
            };
        },
        department: (context) => departmentFrom(context, 'OPEN_OBJECTION_COUNT', 'Land Acquisition Cell', 'Owner of objection hearings and stakeholder resolution.'),
        action: (evidence) => `Schedule hearings for the ${formatCount(evidence.measuredValue, 'unresolved objection')} and assign a reviewing officer to each.`,
        reason: (evidence, context) => `${formatCount(evidence.measuredValue, 'landowner objection')} remain unresolved against a review threshold of ${evidence.threshold}, and open objection volume ${ASSOCIATION_CLAUSE}.${historicalClause(context, 'OPEN_OBJECTION_COUNT')}`,
        impact: () => 'May reduce the unresolved stakeholder workload and could help mitigate escalation of objections into legal disputes.',
    },
    {
        code: 'OPEN_LEGAL_CASE_COUNT',
        label: 'Open legal cases against the acquisition',
        featureCodes: ['open_legal_case_count', 'legal_dispute_flag'],
        linkedFactorCodes: ['OPEN_LEGAL_CASE_COUNT', 'LEGAL_DISPUTE_FLAG', 'LEGAL_DISPUTE'],
        impactCategory: 'LEGAL_CONSTRAINT',
        extract: (context) => {
            const count = context.metrics.openLegalCaseCount;
            const flagged = context.metrics.legalDisputeFlag === true;
            if (!isNumber(count) || count <= 0) {
                if (!flagged)
                    return null;
                return {
                    measuredValue: 1,
                    unit: 'dispute',
                    severity: 0.5,
                    severityFunction: 'policySeverity(legal_dispute_flag=true, no case count recorded)',
                    source: 'PROJECT_DATA',
                    description: 'A legal dispute is flagged but no case count is recorded.',
                    featureCodes: ['legal_dispute_flag'],
                };
            }
            const threshold = CODE_POLICY.OPEN_LEGAL_CASE_COUNT.threshold;
            return {
                measuredValue: count,
                unit: 'case',
                comparisonValue: threshold,
                severity: ratioSeverity(count, threshold),
                severityFunction: `ratioSeverity(open_legal_case_count=${count}, threshold=${threshold})`,
                source: 'PROJECT_DATA',
                description: `${formatCount(count, 'legal case')} are open against this acquisition.`,
            };
        },
        department: () => ({ name: 'Legal Department', basis: 'Statutory owner of litigation and dispute representation.' }),
        action: (evidence) => `Assign legal representation and a hearing calendar for the ${formatCount(evidence.measuredValue, evidence.unit)} currently open.`,
        reason: (evidence, context) => `${formatCount(evidence.measuredValue, evidence.unit)} are open against this acquisition, and open legal exposure ${ASSOCIATION_CLAUSE}.${historicalClause(context, 'OPEN_LEGAL_CASE_COUNT')}`,
        impact: () => 'May give the litigation a tracked hearing calendar and could help mitigate procedural delay from unrepresented matters.',
    },
    {
        code: 'MISSING_DOCUMENT_COUNT',
        label: 'Required documents missing',
        featureCodes: ['missing_document_count', 'required_document_count', 'document_completeness_ratio'],
        linkedFactorCodes: ['MISSING_DOCUMENT_COUNT', 'DOCUMENT_GAP', 'DOCUMENT_COMPLETENESS_RATIO', 'REQUIRED_DOCUMENT_COUNT'],
        impactCategory: 'READINESS_GAP',
        extract: (context) => {
            const resolved = resolveCount(context, 'MISSING_DOCUMENT_COUNT', context.metrics.missingDocumentCount);
            if (!resolved || resolved.value <= 0)
                return null;
            const threshold = CODE_POLICY.MISSING_DOCUMENT_COUNT.threshold;
            return {
                measuredValue: resolved.value,
                unit: unitFor(resolved.task, 'document'),
                comparisonValue: context.metrics.requiredDocumentCount ?? threshold,
                severity: ratioSeverity(resolved.value, threshold),
                severityFunction: `ratioSeverity(missing_document_count=${resolved.value}, threshold=${threshold})`,
                source: resolved.source,
                description: `${formatCount(resolved.value, 'required document')} are missing from the case file.`,
            };
        },
        department: (context) => departmentFrom(context, 'MISSING_DOCUMENT_COUNT', 'Revenue Department', 'Owner of the acquisition document checklist.'),
        action: (evidence) => `Complete the document checklist for the ${formatCount(evidence.measuredValue, 'missing required document')} and record each submission.`,
        reason: (evidence, context) => `${formatCount(evidence.measuredValue, 'required document')} are missing from the case file, and an incomplete document set ${ASSOCIATION_CLAUSE}.${historicalClause(context, 'MISSING_DOCUMENT_COUNT')}`,
        impact: () => 'May close the readiness gap in the case file and could help mitigate rework at the next verification stage.',
    },
    {
        code: 'INVALID_DOCUMENT_COUNT',
        label: 'Rejected or expired documents',
        featureCodes: ['invalid_document_count'],
        linkedFactorCodes: ['INVALID_DOCUMENT_COUNT'],
        impactCategory: 'READINESS_GAP',
        extract: (context) => {
            const resolved = resolveCount(context, 'INVALID_DOCUMENT_COUNT', context.metrics.invalidDocumentCount);
            if (!resolved || resolved.value <= 0)
                return null;
            const threshold = CODE_POLICY.INVALID_DOCUMENT_COUNT.threshold;
            return {
                measuredValue: resolved.value,
                unit: unitFor(resolved.task, 'document'),
                comparisonValue: threshold,
                severity: ratioSeverity(resolved.value, threshold),
                severityFunction: `ratioSeverity(invalid_document_count=${resolved.value}, threshold=${threshold})`,
                source: resolved.source,
                description: `${formatCount(resolved.value, 'document')} are recorded as rejected or expired.`,
            };
        },
        department: (context) => departmentFrom(context, 'INVALID_DOCUMENT_COUNT', 'Revenue Department', 'Owner of document verification and re-submission.'),
        action: (evidence) => `Obtain valid replacements for the ${formatCount(evidence.measuredValue, 'rejected or expired document')} and re-submit them for verification.`,
        reason: (evidence, context) => `${formatCount(evidence.measuredValue, 'document')} are recorded as rejected or expired, and invalid supporting evidence ${ASSOCIATION_CLAUSE}.${historicalClause(context, 'INVALID_DOCUMENT_COUNT')}`,
        impact: () => 'May restore a valid evidence set for the case and could help mitigate rejection at the next approval step.',
    },
    {
        code: 'DOCUMENT_VERIFICATION_PENDING',
        label: 'Submitted documents awaiting verification',
        featureCodes: ['document_verification_pending_count'],
        linkedFactorCodes: ['DOCUMENT_VERIFICATION_PENDING_COUNT'],
        impactCategory: 'READINESS_GAP',
        extract: (context) => {
            const resolved = resolveCount(context, 'DOCUMENT_VERIFICATION_PENDING', context.metrics.documentVerificationPendingCount);
            if (!resolved || resolved.value <= 0)
                return null;
            const threshold = CODE_POLICY.DOCUMENT_VERIFICATION_PENDING.threshold;
            return {
                measuredValue: resolved.value,
                unit: unitFor(resolved.task, 'document'),
                comparisonValue: threshold,
                severity: ratioSeverity(resolved.value, threshold),
                severityFunction: `ratioSeverity(document_verification_pending_count=${resolved.value}, threshold=${threshold})`,
                source: resolved.source,
                description: `${formatCount(resolved.value, 'submitted document')} are awaiting verification.`,
            };
        },
        department: (context) => departmentFrom(context, 'DOCUMENT_VERIFICATION_PENDING', 'Revenue Department', 'Owner of document verification.'),
        action: (evidence) => `Clear the verification backlog of ${formatCount(evidence.measuredValue, 'submitted document')}.`,
        reason: (evidence, context) => `${formatCount(evidence.measuredValue, 'submitted document')} are awaiting verification against a queue threshold of ${evidence.threshold}, and an ageing verification backlog ${ASSOCIATION_CLAUSE}.${historicalClause(context, 'DOCUMENT_VERIFICATION_PENDING')}`,
        impact: () => 'May reduce the verification backlog and could help mitigate downstream approval waiting time.',
    },
    {
        code: 'BLOCKED_DEPENDENCY_COUNT',
        label: 'Blocked inter-department dependencies',
        featureCodes: ['blocked_dependency_count', 'interdepartment_dependency_count'],
        linkedFactorCodes: ['BLOCKED_DEPENDENCY_COUNT', 'INTERDEPARTMENT_DEPENDENCY_COUNT'],
        impactCategory: 'COORDINATION_BLOCKER',
        extract: (context) => {
            const resolved = resolveCount(context, 'BLOCKED_DEPENDENCY_COUNT', context.metrics.blockedDependencyCount);
            if (!resolved || resolved.value <= 0)
                return null;
            const threshold = CODE_POLICY.BLOCKED_DEPENDENCY_COUNT.threshold;
            return {
                measuredValue: resolved.value,
                unit: unitFor(resolved.task, 'dependency'),
                comparisonValue: threshold,
                severity: ratioSeverity(resolved.value, threshold),
                severityFunction: `ratioSeverity(blocked_dependency_count=${resolved.value}, threshold=${threshold})`,
                source: resolved.source,
                description: `${formatCount(resolved.value, 'inter-department dependency')} are recorded as blocked.`,
            };
        },
        department: (context) => departmentFrom(context, 'BLOCKED_DEPENDENCY_COUNT', 'District Administration', 'Coordinating authority for inter-department dependencies.'),
        action: (evidence) => `Convene a coordination review for the ${formatCount(evidence.measuredValue, 'blocked dependency')} and record an owner and unblock date for each.`,
        reason: (evidence, context) => `${formatCount(evidence.measuredValue, 'inter-department dependency')} are blocked against a threshold of ${evidence.threshold}, and blocked dependencies ${ASSOCIATION_CLAUSE}.${historicalClause(context, 'BLOCKED_DEPENDENCY_COUNT')}`,
        impact: () => 'May give each blocked dependency a named owner and could help mitigate idle waiting between departments.',
    },
    {
        code: 'MILESTONE_SLIPPAGE_COUNT',
        label: 'Repeated milestone slippage',
        featureCodes: ['milestone_slippage_count'],
        linkedFactorCodes: ['MILESTONE_SLIPPAGE_COUNT', 'MILESTONE_SLIPPAGE'],
        impactCategory: 'SCHEDULE_RECOVERY',
        extract: (context) => {
            const count = context.metrics.milestoneSlippageCount;
            if (!isNumber(count) || count <= 0)
                return null;
            const threshold = CODE_POLICY.MILESTONE_SLIPPAGE_COUNT.threshold;
            return {
                measuredValue: count,
                unit: 'missed milestone',
                comparisonValue: threshold,
                severity: ratioSeverity(count, threshold),
                severityFunction: `ratioSeverity(milestone_slippage_count=${count}, threshold=${threshold})`,
                source: 'PROJECT_DATA',
                description: `${formatCount(count, 'milestone')} have been missed or rescheduled on this project.`,
            };
        },
        department: (context) => ({
            name: context.project.department,
            basis: 'Owning department of the project schedule.',
        }),
        action: () => 'Hold a corrective project review covering the repeatedly missed milestones and record a revised, resourced schedule.',
        reason: (evidence, context) => `${formatCount(evidence.measuredValue, 'milestone')} have already been missed or rescheduled, and repeated slippage ${ASSOCIATION_CLAUSE}.${historicalClause(context, 'MILESTONE_SLIPPAGE_COUNT')}`,
        impact: () => 'May surface the recurring schedule constraint at project level and could help mitigate continued drift across stages.',
    },
    {
        code: 'STAGE_AGING',
        label: 'Current stage older than its baseline',
        featureCodes: ['days_in_current_stage', 'average_stage_duration_days'],
        linkedFactorCodes: ['DAYS_IN_CURRENT_STAGE', 'STAGE_AGING', 'AVERAGE_STAGE_DURATION_DAYS'],
        impactCategory: 'SCHEDULE_RECOVERY',
        extract: (context) => {
            const days = context.metrics.daysInCurrentStage;
            const baseline = context.metrics.averageStageDurationDays ?? context.historicalPatterns?.averageStageDurationDays ?? null;
            if (!isNumber(days) || !isNumber(baseline) || baseline <= 0 || days <= baseline)
                return null;
            return {
                measuredValue: days,
                unit: 'day',
                comparisonValue: baseline,
                severity: baselineRatioSeverity(days, baseline),
                severityFunction: `baselineRatioSeverity(days_in_current_stage=${days}, baseline=${baseline})`,
                source: 'PROJECT_DATA',
                description: `The current stage has been open for ${formatCount(days, 'day')} against a baseline of ${formatCount(baseline, 'day')}.`,
            };
        },
        department: milestoneOwnerOrProject,
        action: (_evidence, context) => `Review the bottleneck in the "${context.milestone?.stage ?? context.milestone?.name ?? 'current'}" stage and assign an owner to the activity holding it open.`,
        reason: (evidence, context) => `The current stage has been open for ${formatCount(evidence.measuredValue, 'day')} against a baseline of ${formatCount(evidence.comparisonValue ?? 0, 'day')}, and stage age beyond its baseline ${ASSOCIATION_CLAUSE}.${historicalClause(context, 'STAGE_AGING')}`,
        impact: () => 'May identify the specific activity holding the stage open and could help mitigate further stagnation.',
    },
    {
        code: 'DEPARTMENT_CAPACITY',
        label: 'Responsible department near capacity',
        featureCodes: ['department_workload_index', 'historical_department_delay_rate'],
        linkedFactorCodes: ['DEPARTMENT_WORKLOAD_INDEX', 'HISTORICAL_DEPARTMENT_DELAY_RATE'],
        impactCategory: 'CAPACITY_CONSTRAINT',
        extract: (context) => {
            let saturated = null;
            for (const workload of context.workloadByDepartment.values()) {
                if (!isNumber(workload.workloadIndex))
                    continue;
                if (workload.workloadIndex < CODE_POLICY.DEPARTMENT_CAPACITY.threshold)
                    continue;
                if (!saturated || workload.workloadIndex > saturated.workloadIndex)
                    saturated = workload;
            }
            if (!saturated)
                return null;
            const index = clamp(saturated.workloadIndex, 0, 2);
            const threshold = CODE_POLICY.DEPARTMENT_CAPACITY.threshold;
            const openItems = isNumber(saturated.openItems) ? ` with ${formatCount(saturated.openItems, 'open item')}` : '';
            return {
                measuredValue: Number(index.toFixed(3)),
                unit: 'workload index',
                comparisonValue: threshold,
                severity: ratioSeverity(index - threshold, 1 - threshold),
                severityFunction: `ratioSeverity(department_workload_index=${index.toFixed(3)} - threshold=${threshold}, span=${(1 - threshold).toFixed(2)})`,
                source: 'DEPARTMENT_WORKLOAD',
                description: `${saturated.department} is carrying a workload index of ${index.toFixed(2)}${openItems}, at or above the ${threshold} capacity threshold.`,
            };
        },
        department: (context) => {
            let saturated = null;
            for (const workload of context.workloadByDepartment.values()) {
                if (!isNumber(workload.workloadIndex))
                    continue;
                if (!saturated || workload.workloadIndex > saturated.workloadIndex)
                    saturated = workload;
            }
            return saturated
                ? { name: saturated.department, basis: 'Department reporting the highest recorded workload index.' }
                : { name: context.project.department, basis: 'Owning department of the project.' };
        },
        action: (evidence) => `Rebalance the case load or add reviewing officers where the workload index stands at ${evidence.measuredValue.toFixed(2)}, and confirm which pending items are reassigned.`,
        reason: (evidence) => `${evidence.description} A department workload index at or above the capacity threshold ${ASSOCIATION_CLAUSE}, and rebalancing is recommended because the actions above are assigned to a queue already at capacity.`,
        impact: () => 'May free reviewing capacity for the higher-priority actions on this project and could help mitigate queueing delay.',
    },
    {
        code: 'STALE_CASE_DATA',
        label: 'Case record not updated recently',
        featureCodes: ['days_since_last_update'],
        linkedFactorCodes: ['DAYS_SINCE_LAST_UPDATE'],
        impactCategory: 'DATA_QUALITY',
        extract: (context) => {
            const days = context.metrics.daysSinceLastUpdate;
            if (!isNumber(days) || days <= 0)
                return null;
            // No early return below the threshold: the observation is still emitted so
            // the suppression reason reports the measured value rather than "no data".
            const threshold = CODE_POLICY.STALE_CASE_DATA.threshold;
            return {
                measuredValue: days,
                unit: 'day',
                comparisonValue: threshold,
                severity: sigmoidSeverity(days, threshold, threshold / 3),
                severityFunction: `sigmoidSeverity(days_since_last_update=${days}, tolerance=${threshold}, scale=${(threshold / 3).toFixed(1)})`,
                source: 'PROJECT_DATA',
                description: `The case record has not been updated for ${formatCount(days, 'day')}.`,
            };
        },
        department: (context) => ({
            name: context.project.department,
            basis: 'Owning department responsible for case record upkeep.',
        }),
        action: (evidence) => `Refresh the case record, which has not been updated for ${formatCount(evidence.measuredValue, 'day')}, and confirm the current stage, documents, and objection counts.`,
        reason: (evidence) => `${evidence.description} A stale record ${ASSOCIATION_CLAUSE} and also lowers the confidence of every other item on this list, so an update is recommended because the remaining recommendations depend on it.`,
        impact: () => 'May improve the evidence quality behind this assessment and could help surface bottlenecks that current data does not yet show.',
    },
];
export const CATALOG_BY_CODE = new Map(CATALOG.map((entry) => [entry.code, entry]));
