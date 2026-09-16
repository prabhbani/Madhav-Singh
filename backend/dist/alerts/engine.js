/**
 * Early warning engine.
 *
 * Runs every detector against one snapshot, then decides what each detected
 * condition means for the alert that already exists: raise, escalate, leave
 * alone, or resolve. Pure and deterministic, with no database, clock, or network
 * access, so the same snapshot always yields the same decisions.
 *
 * The anti-fatigue controls are the point of this layer:
 *
 *   1. One live alert per project and detector type.
 *   2. A quantized condition hash, so an unchanged condition never re-raises.
 *   3. A per-severity cooldown, which an escalation is allowed to break.
 *   4. Correlation groups, so one underlying signal pages once.
 *   5. A per-run notification budget for the lower severities.
 *   6. Dismissals that hold until the condition clears or escalates.
 */
import { DETECTORS } from './detectors.js';
import { ALERT_POLICY_VERSION, COOLDOWN_HOURS, DEGRADED_PREDICTION_SEVERITY_CAP, DETECTOR_VERSION, MODEL_DERIVED_DETECTORS, NOTIFICATION_POLICY, SEVERITY_ORDER, lowerSeverity, } from './policy.js';
import { renderAction, assertNonCausal } from '../recommendations/wording.js';
import { fingerprint } from '../shared/hash.js';
const MS_PER_HOUR = 3_600_000;
const LIVE_STATUSES = new Set(['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS']);
const toDate = (value) => {
    if (value === null || value === undefined)
        return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
/** Base limitations carried by every alert, per the explainability policy. */
const BASE_ALERT_LIMITATIONS = [
    'This is a threshold crossing on recorded data, not a causal finding.',
    'The alert depends on the completeness and freshness of the case record.',
    'An authorized official decides what action, if any, the alert warrants.',
];
// ---------------------------------------------------------------------------
// Context assembly
// ---------------------------------------------------------------------------
const buildDetectionContext = (input, asOfAt) => {
    const metrics = input.project.metrics ?? {};
    const upcomingMilestones = (input.upcomingMilestones ?? [])
        .map((milestone) => ({ milestone, plannedDate: toDate(milestone.plannedAt) }))
        .filter((entry) => entry.plannedDate !== null)
        .filter(({ milestone }) => milestone.status !== 'COMPLETED' && milestone.status !== 'CANCELLED')
        .map(({ milestone, plannedDate }) => ({ ...milestone, plannedDate }))
        .sort((left, right) => left.plannedDate.getTime() - right.plannedDate.getTime());
    // The current prediction is appended as the newest point, so the trend and
    // jump detectors compare history against the value being evaluated now.
    const historyPoints = (input.predictionHistory ?? [])
        .map((point) => {
        const at = toDate(point.predictedAt);
        const value = isNumber(point.riskScore) ? point.riskScore : point.delayProbability;
        return at && isNumber(value) ? { ...point, at, value } : null;
    })
        .filter((point) => point !== null)
        .sort((left, right) => left.at.getTime() - right.at.getTime());
    const currentValue = isNumber(input.prediction.riskScore)
        ? input.prediction.riskScore
        : input.prediction.delayProbability;
    const currentAt = toDate(input.prediction.predictedAt) ?? asOfAt;
    const last = historyPoints[historyPoints.length - 1];
    if (isNumber(currentValue) && (!last || last.at.getTime() < currentAt.getTime())) {
        historyPoints.push({
            predictedAt: currentAt,
            delayProbability: input.prediction.delayProbability,
            riskScore: input.prediction.riskScore,
            riskLevel: input.prediction.riskLevel,
            predictionId: input.prediction.predictionId,
            at: currentAt,
            value: currentValue,
        });
    }
    const observationHistory = (input.observationHistory ?? [])
        .map((point) => {
        const at = toDate(point.observedAt);
        return at ? { ...point, at } : null;
    })
        .filter((point) => point !== null)
        .sort((left, right) => left.at.getTime() - right.at.getTime());
    const workloadByDepartment = new Map();
    for (const workload of input.departmentWorkload ?? []) {
        if (workload?.department)
            workloadByDepartment.set(workload.department, workload);
    }
    const officersByDepartment = new Map();
    for (const officer of input.responsibleOfficers ?? []) {
        if (officer?.department && !officersByDepartment.has(officer.department)) {
            officersByDepartment.set(officer.department, officer);
        }
    }
    return {
        asOfAt,
        project: input.project,
        metrics,
        currentMilestone: input.currentMilestone ?? null,
        upcomingMilestones,
        prediction: input.prediction,
        predictionHistory: historyPoints,
        observationHistory,
        workloadByDepartment,
        officersByDepartment,
    };
};
const governSeverity = (detector, condition, input) => {
    const overrides = [];
    let severity = condition.severity;
    if (condition.override)
        overrides.push(condition.override);
    const status = input.prediction.predictionStatus ?? 'OK';
    const degraded = status === 'RULE_ONLY_FALLBACK' || status === 'STALE' || status === 'DEGRADED' || input.prediction.confidenceBand === 'LOW';
    if (degraded && MODEL_DERIVED_DETECTORS.includes(detector.type)) {
        const capped = lowerSeverity(severity, DEGRADED_PREDICTION_SEVERITY_CAP);
        if (capped !== severity) {
            overrides.push(`DEGRADED_PREDICTION_CAP: prediction status ${status} with confidence band ${input.prediction.confidenceBand ?? 'UNKNOWN'}; severity capped at ${DEGRADED_PREDICTION_SEVERITY_CAP}.`);
            severity = capped;
        }
    }
    return { severity, basis: overrides.length > 0 ? 'POLICY_OVERRIDE' : 'THRESHOLD_LADDER', overrides };
};
export const evaluateAlerts = (input, options = {}) => {
    const asOfAt = toDate(input.asOfAt) ?? new Date();
    const generatedAt = toDate(options.generatedAt) ?? asOfAt;
    const budget = options.maxNotificationsPerRun ?? NOTIFICATION_POLICY.maxNotificationsPerProjectPerRun;
    const context = buildDetectionContext(input, asOfAt);
    const existingByType = new Map();
    for (const existing of input.existingAlerts ?? []) {
        if (existing?.alertType)
            existingByType.set(String(existing.alertType), existing);
    }
    const suppressed = [];
    const resolved = [];
    const candidates = [];
    // --- Pass 1: detection -----------------------------------------------------
    for (const detector of DETECTORS) {
        let condition;
        try {
            condition = detector.detect(context);
        }
        catch (error) {
            suppressed.push({
                alertType: detector.type,
                reason: 'INPUT_UNAVAILABLE',
                detail: `Detection failed: ${error.message}`,
                severity: null,
            });
            continue;
        }
        if (!condition) {
            const existing = existingByType.get(detector.type);
            if (existing && LIVE_STATUSES.has(existing.status)) {
                resolved.push({
                    alertType: detector.type,
                    previousSeverity: existing.severity,
                    reason: 'CONDITION_CLEARED: the measured value no longer crosses any policy threshold.',
                });
            }
            else {
                suppressed.push({
                    alertType: detector.type,
                    reason: 'NO_CONDITION',
                    detail: `No threshold crossing for ${detector.featureCodes.join(', ')} in the supplied inputs.`,
                    severity: null,
                });
            }
            continue;
        }
        const governed = governSeverity(detector, condition, input);
        candidates.push({
            detector,
            condition,
            severity: governed.severity,
            severityBasis: governed.basis,
            overrides: governed.overrides,
            conditionHash: fingerprint(`${detector.type}|${condition.stateBucket}|${ALERT_POLICY_VERSION}`).slice(0, 16),
        });
    }
    // --- Pass 2: correlation ---------------------------------------------------
    // One underlying signal should page once. Within a group the strongest
    // severity wins, ties broken by declared precedence.
    const strongestInGroup = new Map();
    for (const candidate of candidates) {
        const group = candidate.detector.correlationGroup;
        if (!group)
            continue;
        const current = strongestInGroup.get(group);
        if (!current) {
            strongestInGroup.set(group, candidate);
            continue;
        }
        const bySeverity = SEVERITY_ORDER[candidate.severity] - SEVERITY_ORDER[current.severity];
        const byPrecedence = (candidate.detector.correlationPrecedence ?? 0) - (current.detector.correlationPrecedence ?? 0);
        if (bySeverity > 0 || (bySeverity === 0 && byPrecedence > 0))
            strongestInGroup.set(group, candidate);
    }
    const retained = [];
    for (const candidate of candidates) {
        const group = candidate.detector.correlationGroup;
        const winner = group ? strongestInGroup.get(group) : undefined;
        if (group && winner && winner !== candidate) {
            suppressed.push({
                alertType: candidate.detector.type,
                reason: 'CORRELATED_ALERT',
                detail: `${winner.detector.type} (${winner.severity}) covers the same ${group} signal; this ${candidate.severity} alert is not raised separately.`,
                severity: candidate.severity,
            });
            const existing = existingByType.get(candidate.detector.type);
            if (existing && LIVE_STATUSES.has(existing.status)) {
                resolved.push({
                    alertType: candidate.detector.type,
                    previousSeverity: existing.severity,
                    reason: `SUPERSEDED_BY_CORRELATED_ALERT: ${winner.detector.type} now covers this signal.`,
                });
            }
            continue;
        }
        retained.push(candidate);
    }
    // --- Pass 3: deduplication, cooldown, and decisions ------------------------
    const alerts = [];
    const dataOrigin = input.project.dataOrigin ?? null;
    const predictionStatus = input.prediction.predictionStatus ?? 'OK';
    for (const candidate of retained) {
        const { detector, condition, severity } = candidate;
        const existing = existingByType.get(detector.type);
        const previousSeverity = existing ? existing.severity : null;
        const cooldownUntil = toDate(existing?.cooldownUntil);
        const inCooldown = cooldownUntil !== null && cooldownUntil > asOfAt;
        if (existing?.status === 'DISMISSED') {
            const escalated = SEVERITY_ORDER[severity] > SEVERITY_ORDER[existing.severity];
            if (!(escalated && NOTIFICATION_POLICY.reRaiseDismissedOnEscalation)) {
                suppressed.push({
                    alertType: detector.type,
                    reason: 'DISMISSED_BY_OFFICER',
                    detail: `An official dismissed this alert at ${existing.severity}; the condition has not escalated beyond that.`,
                    severity,
                });
                continue;
            }
        }
        let decision;
        let decisionReason;
        let notify = false;
        let notifyBasis;
        const liveExisting = existing !== undefined && LIVE_STATUSES.has(existing.status);
        const sameCondition = existing !== undefined && existing.conditionHash === candidate.conditionHash;
        if (!existing || existing.status === 'RESOLVED' || existing.status === 'DISMISSED') {
            decision = existing ? 'REOPENED' : 'CREATED';
            decisionReason = existing
                ? `The condition is present again after the alert was ${existing.status.toLowerCase()}.`
                : 'First threshold crossing recorded for this detector on this project.';
            notify = true;
            notifyBasis = 'A newly raised condition notifies, subject to severity and budget.';
        }
        else if (SEVERITY_ORDER[severity] > SEVERITY_ORDER[existing.severity]) {
            decision = 'ESCALATED';
            decisionReason = `Severity rose from ${existing.severity} to ${severity}.`;
            notify = true;
            notifyBasis = inCooldown
                ? 'Escalation breaks the active cooldown, so the alert notifies.'
                : 'Escalation notifies.';
        }
        else if (SEVERITY_ORDER[severity] < SEVERITY_ORDER[existing.severity]) {
            decision = 'DE_ESCALATED';
            decisionReason = `Severity fell from ${existing.severity} to ${severity}.`;
            notify = false;
            notifyBasis = 'A weakening condition updates the alert in place without notifying.';
        }
        else if (sameCondition) {
            decision = 'UNCHANGED';
            decisionReason = `The condition state is unchanged since the last evaluation (observation ${(existing.occurrenceCount ?? 1) + 1}).`;
            notify = false;
            notifyBasis = 'An unchanged condition never re-notifies.';
            suppressed.push({
                alertType: detector.type,
                reason: 'UNCHANGED_CONDITION',
                detail: `Condition hash ${candidate.conditionHash} matches the stored alert; the alert was updated, not re-raised.`,
                severity,
            });
        }
        else {
            decision = 'REOPENED';
            decisionReason = `The condition state changed within the ${severity} band (${existing.conditionHash} to ${candidate.conditionHash}).`;
            notify = true;
            notifyBasis = 'A different condition instance at the same severity notifies, subject to cooldown.';
        }
        // Cooldown applies to everything except an escalation.
        if (notify && decision !== 'ESCALATED' && inCooldown) {
            notify = false;
            notifyBasis = `Held by the ${severity} cooldown until ${cooldownUntil?.toISOString()}.`;
            suppressed.push({
                alertType: detector.type,
                reason: 'COOLDOWN',
                detail: `Notification held until ${cooldownUntil?.toISOString()}; the alert remains live in the notification centre.`,
                severity,
            });
        }
        // INFO populates the centre but does not push.
        if (notify && SEVERITY_ORDER[severity] < SEVERITY_ORDER[NOTIFICATION_POLICY.minSeverityToNotify]) {
            notify = false;
            notifyBasis = `Severity ${severity} is below the ${NOTIFICATION_POLICY.minSeverityToNotify} notification floor; the alert is listed but not pushed.`;
        }
        const department = detector.department(context, condition);
        const officer = context.officersByDepartment.get(department.name) ?? null;
        const firstTriggeredAt = toDate(existing?.firstTriggeredAt) ?? asOfAt;
        const occurrenceCount = liveExisting ? (existing.occurrenceCount ?? 1) + 1 : 1;
        const limitations = [...BASE_ALERT_LIMITATIONS];
        if (predictionStatus !== 'OK') {
            limitations.push(`Prediction status is ${predictionStatus}; model-derived alerts are capped and may be unreliable.`);
        }
        if (input.prediction.confidenceBand === 'LOW')
            limitations.push('Prediction confidence for this project is LOW.');
        if (dataOrigin === 'SYNTHETIC_DEMO') {
            limitations.push('Underlying data is marked SYNTHETIC_DEMO and must not support an official decision.');
        }
        if (candidate.severityBasis === 'POLICY_OVERRIDE') {
            limitations.push('The severity was set by a policy override, not by the threshold ladder alone.');
        }
        if (!officer) {
            limitations.push('No officer is mapped to the responsible department; the alert is routed to the department only.');
        }
        alerts.push({
            alertType: detector.type,
            label: detector.label,
            category: detector.category,
            project: {
                projectId: input.project.projectId,
                projectCode: input.project.projectCode ?? null,
                name: input.project.name ?? null,
            },
            severity,
            severityBasis: candidate.severityBasis,
            appliedOverrides: candidate.overrides,
            trigger: condition.triggerExpression,
            triggeredAt: (decision === 'CREATED' || decision === 'REOPENED' ? asOfAt : firstTriggeredAt).toISOString(),
            description: assertNonCausal('description', detector.description(condition, context)),
            recommendedAction: renderAction(detector.recommendedAction(condition, context)),
            responsible: {
                department: department.name,
                basis: officer
                    ? `${department.basis} ${officer.matchBasis ?? 'Officer matched from the user directory.'}`
                    : department.basis,
                officerId: officer?.officerId ?? null,
                officerName: officer?.officerName ?? null,
            },
            acknowledgement: {
                status: liveExisting ? existing.status : 'OPEN',
                acknowledgedAt: toDate(existing?.acknowledgedAt)?.toISOString() ?? null,
                occurrenceCount,
                firstTriggeredAt: firstTriggeredAt.toISOString(),
                lastObservedAt: asOfAt.toISOString(),
            },
            evidence: {
                measuredValue: condition.measuredValue,
                unit: condition.unit,
                threshold: condition.threshold,
                comparisonValue: condition.comparisonValue ?? null,
                source: condition.source,
                featureCodes: condition.featureCodes ?? detector.featureCodes,
                observedAt: (condition.observedAt ?? asOfAt).toISOString(),
                context: condition.context,
            },
            conditionHash: candidate.conditionHash,
            decision,
            decisionReason,
            notify,
            notifyBasis,
            cooldownUntil: cooldownUntil?.toISOString() ?? null,
            previousSeverity,
            limitations,
        });
    }
    // --- Pass 4: notification budget -------------------------------------------
    // The budget throttles the lower severities only. Throttling a HIGH or
    // CRITICAL to keep a queue tidy would defeat the purpose of the system.
    const exempt = new Set(NOTIFICATION_POLICY.budgetExemptSeverities);
    const notifying = alerts.filter((alert) => alert.notify);
    notifying.sort((left, right) => SEVERITY_ORDER[right.severity] - SEVERITY_ORDER[left.severity]);
    let spent = 0;
    for (const alert of notifying) {
        if (exempt.has(alert.severity))
            continue;
        if (spent < budget) {
            spent += 1;
            continue;
        }
        alert.notify = false;
        alert.notifyBasis = `Held by the per-run notification budget of ${budget} for severities below ${NOTIFICATION_POLICY.budgetExemptSeverities.join('/')}.`;
        suppressed.push({
            alertType: alert.alertType,
            reason: 'NOTIFICATION_BUDGET',
            detail: `Per-run budget of ${budget} lower-severity notifications was already spent; the alert remains live in the notification centre.`,
            severity: alert.severity,
        });
    }
    // Set the forward cooldown only for alerts this run actually notified.
    for (const alert of alerts) {
        if (!alert.notify)
            continue;
        alert.cooldownUntil = new Date(asOfAt.getTime() + COOLDOWN_HOURS[alert.severity] * MS_PER_HOUR).toISOString();
    }
    alerts.sort((left, right) => {
        const bySeverity = SEVERITY_ORDER[right.severity] - SEVERITY_ORDER[left.severity];
        if (bySeverity !== 0)
            return bySeverity;
        if (left.notify !== right.notify)
            return left.notify ? -1 : 1;
        return left.alertType.localeCompare(right.alertType);
    });
    const missingInputBlocks = [];
    if ((input.predictionHistory ?? []).length === 0)
        missingInputBlocks.push('predictionHistory');
    if ((input.observationHistory ?? []).length === 0)
        missingInputBlocks.push('observationHistory');
    if ((input.departmentWorkload ?? []).length === 0)
        missingInputBlocks.push('departmentWorkload');
    if ((input.responsibleOfficers ?? []).length === 0)
        missingInputBlocks.push('responsibleOfficers');
    if ((input.upcomingMilestones ?? []).length === 0)
        missingInputBlocks.push('upcomingMilestones');
    if (Object.keys(context.metrics).length === 0)
        missingInputBlocks.push('project.metrics');
    const warnings = [];
    if (missingInputBlocks.length > 0) {
        warnings.push(`Detection ran on partial inputs; these blocks were not supplied: ${missingInputBlocks.join(', ')}.`);
    }
    if (predictionStatus !== 'OK')
        warnings.push(`Prediction status is ${predictionStatus}; model-derived detectors are capped.`);
    if (dataOrigin === 'SYNTHETIC_DEMO')
        warnings.push('Project data origin is SYNTHETIC_DEMO.');
    const bySeverity = { INFO: 0, WARNING: 0, HIGH: 0, CRITICAL: 0 };
    for (const alert of alerts)
        bySeverity[alert.severity] += 1;
    const count = (decision) => alerts.filter((alert) => alert.decision === decision).length;
    return {
        projectId: input.project.projectId,
        asOfAt: asOfAt.toISOString(),
        generatedAt: generatedAt.toISOString(),
        policyVersion: ALERT_POLICY_VERSION,
        detectorVersion: DETECTOR_VERSION,
        alerts,
        notifications: alerts.filter((alert) => alert.notify),
        resolved,
        suppressed,
        dataQuality: {
            dataOrigin,
            predictionStatus,
            confidenceBand: input.prediction.confidenceBand ?? null,
            missingInputBlocks,
            warnings,
        },
        summary: {
            evaluatedDetectors: DETECTORS.length,
            created: count('CREATED'),
            escalated: count('ESCALATED'),
            deEscalated: count('DE_ESCALATED'),
            unchanged: count('UNCHANGED'),
            reopened: count('REOPENED'),
            resolved: resolved.length,
            suppressed: suppressed.length,
            notified: alerts.filter((alert) => alert.notify).length,
            bySeverity,
        },
    };
};
export const alertTypes = () => DETECTORS.map((detector) => detector.type);
