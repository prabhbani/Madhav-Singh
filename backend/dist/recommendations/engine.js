/**
 * Recommendation engine.
 *
 * Pure and deterministic: the same input always produces the same output, with
 * no database, clock, or network access beyond an optional `generatedAt`
 * override. Every emitted field is derived from a supplied input value, and the
 * component scores that produced the ranking are returned alongside it.
 */
import { CATALOG, buildObservation, } from './catalog.js';
import { CATALOG_VERSION, CODE_POLICY, DEADLINE_URGENCY_FACTOR, ENGINE_LIMITS, POLICY_VERSION, PRIORITY_BANDS, RANKING_WEIGHTS, clamp, } from './policy.js';
import { BASE_LIMITATIONS, renderAction, renderImpact, renderReason } from './wording.js';
// A recommendation keeps the same id across runs, which is what lets stored
// officer status be matched back to it.
import { fingerprint } from '../shared/hash.js';
const MS_PER_DAY = 86_400_000;
const PRIORITY_ORDER = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
const TERMINAL_STATUSES = new Set(['COMPLETED', 'DISMISSED', 'EXPIRED']);
// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const toDate = (value) => {
    if (value === null || value === undefined)
        return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};
const daysBetween = (from, to) => (to.getTime() - from.getTime()) / MS_PER_DAY;
const round = (value, digits = 4) => Number(value.toFixed(digits));
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
/** Normalizes a factor code so `overdue_days` and `OVERDUE_DAYS` both match. */
const normalizeFactorCode = (code) => String(code).trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
const higherPriority = (left, right) => PRIORITY_ORDER[left] >= PRIORITY_ORDER[right] ? left : right;
const lowerPriority = (left, right) => PRIORITY_ORDER[left] <= PRIORITY_ORDER[right] ? left : right;
const bandFor = (score) => {
    for (const band of PRIORITY_BANDS) {
        if (score >= band.min)
            return band.priority;
    }
    return 'LOW';
};
// ---------------------------------------------------------------------------
// Derived inputs
// ---------------------------------------------------------------------------
/** Milestone overdue days, taken from the caller or derived from the plan date. */
const deriveMilestoneOverdueDays = (milestone, metricOverdueDays, asOfAt) => {
    if (milestone && isNumber(milestone.overdueDays))
        return Math.max(0, milestone.overdueDays);
    const plannedAt = toDate(milestone?.plannedAt);
    const completed = milestone?.status === 'COMPLETED' || toDate(milestone?.completedAt) !== null;
    if (plannedAt && !completed) {
        const overdue = daysBetween(plannedAt, asOfAt);
        if (overdue > 0)
            return Math.floor(overdue);
    }
    if (isNumber(metricOverdueDays))
        return Math.max(0, metricOverdueDays);
    return null;
};
/**
 * Indexes the model's top risk factors by normalized code.
 *
 * When the caller supplies `relativeContribution` values those are used. When
 * they are absent, a documented linear rank decay is used instead so a factor
 * list without contributions still ranks deterministically.
 */
const indexRiskFactors = (factors) => {
    const supplied = factors.some((factor) => isNumber(factor.relativeContribution));
    const total = factors.length;
    const decayDenominator = (total * (total + 1)) / 2;
    const byCode = new Map();
    factors.forEach((factor, index) => {
        const rank = index + 1;
        const fallback = decayDenominator > 0 ? (total - index) / decayDenominator : 0;
        const contribution = isNumber(factor.relativeContribution)
            ? clamp(factor.relativeContribution)
            : supplied
                ? 0
                : fallback;
        const code = normalizeFactorCode(factor.factorCode);
        const existing = byCode.get(code);
        if (!existing || contribution > existing.contribution) {
            byCode.set(code, { factor, rank, contribution });
        }
    });
    return { byCode, contributionsSupplied: supplied };
};
const computeModelLinkage = (entry, index) => {
    const matches = [];
    for (const code of entry.linkedFactorCodes) {
        const match = index.byCode.get(normalizeFactorCode(code));
        if (match && !matches.some((existing) => existing.factor === match.factor))
            matches.push(match);
    }
    const contributing = matches.filter((match) => match.factor.direction !== 'REDUCES_RISK');
    if (contributing.length === 0) {
        return {
            score: 0,
            related: null,
            note: 'No model risk factor was linked to this evidence code; the model-linkage component scored 0.',
        };
    }
    const score = clamp(contributing.reduce((sum, match) => sum + match.contribution, 0));
    const best = contributing.reduce((top, match) => (match.contribution > top.contribution ? match : top));
    const related = {
        factorCode: normalizeFactorCode(best.factor.factorCode),
        label: best.factor.label ?? entry.label,
        direction: best.factor.direction ?? 'INCREASES_RISK',
        relativeContribution: index.contributionsSupplied ? round(best.contribution) : null,
        rank: best.rank,
        source: best.factor.source ?? 'ML',
        evidenceAt: toDate(best.factor.evidenceAt)?.toISOString() ?? null,
    };
    const basis = index.contributionsSupplied ? 'supplied relative contributions' : 'rank-based decay (no contributions supplied)';
    return {
        score,
        related,
        note: `Linked to ${contributing.length} model risk factor(s), highest ranked #${best.rank}, scored from ${basis}.`,
    };
};
const computeUrgency = (entry, context, horizonDays, targetDate) => {
    const slaDays = CODE_POLICY[entry.code].slaDays;
    const notes = [];
    const components = [];
    if (targetDate) {
        const daysToTarget = daysBetween(context.asOfAt, targetDate);
        const pressure = daysToTarget <= 0 ? 1 : clamp(1 - daysToTarget / horizonDays);
        components.push(pressure);
        notes.push(daysToTarget <= 0
            ? `Project target date passed ${Math.abs(Math.floor(daysToTarget))} day(s) ago (target pressure 1.00).`
            : `Project target date is ${Math.floor(daysToTarget)} day(s) away against a ${horizonDays}-day horizon (target pressure ${pressure.toFixed(2)}).`);
    }
    if (isNumber(context.milestoneOverdueDays) && context.milestoneOverdueDays > 0) {
        const pressure = clamp(context.milestoneOverdueDays / (2 * slaDays));
        components.push(pressure);
        notes.push(`Current milestone is ${context.milestoneOverdueDays} day(s) overdue against a ${slaDays}-day service window (pressure ${pressure.toFixed(2)}).`);
    }
    const task = context.pendingTaskByCode.get(entry.code);
    if (task && isNumber(task.oldestAgeDays)) {
        const pressure = clamp(task.oldestAgeDays / (2 * slaDays));
        components.push(pressure);
        notes.push(`Oldest outstanding item in this queue is ${task.oldestAgeDays} day(s) old (pressure ${pressure.toFixed(2)}).`);
    }
    const taskDueAt = toDate(task?.dueAt);
    if (taskDueAt) {
        const daysToDue = daysBetween(context.asOfAt, taskDueAt);
        const pressure = daysToDue <= 0 ? 1 : clamp(1 - daysToDue / slaDays);
        components.push(pressure);
        notes.push(`Queue due date is ${Math.floor(daysToDue)} day(s) away (pressure ${pressure.toFixed(2)}).`);
    }
    if (components.length === 0) {
        notes.push('No deadline, milestone, or task-age evidence was available; urgency scored 0.');
        return { score: 0, notes };
    }
    return { score: clamp(Math.max(...components)), notes };
};
const computeHistoricalSupport = (code, context) => {
    const patterns = context.historicalPatterns;
    const outcome = patterns?.evidenceOutcomeRates?.[code];
    if (outcome && outcome.sampleSize >= ENGINE_LIMITS.minHistoricalSampleSize) {
        const lift = clamp(outcome.delayRateWhenPresent - outcome.delayRateWhenAbsent);
        return {
            score: lift,
            usedOutcomeRates: true,
            note: `Completed cases with this evidence were delayed at ${(outcome.delayRateWhenPresent * 100).toFixed(0)}% versus ${(outcome.delayRateWhenAbsent * 100).toFixed(0)}% without it, over ${outcome.sampleSize} cases (lift ${lift.toFixed(2)}).`,
        };
    }
    if (outcome) {
        return {
            score: 0,
            usedOutcomeRates: false,
            note: `Outcome rates for this evidence covered only ${outcome.sampleSize} cases, below the ${ENGINE_LIMITS.minHistoricalSampleSize}-case minimum; historical support scored 0.`,
        };
    }
    const rates = [patterns?.departmentDelayRate, patterns?.districtDelayRate, patterns?.projectTypeDelayRate].filter(isNumber);
    if (rates.length > 0) {
        const score = clamp(Math.max(...rates));
        return {
            score,
            usedOutcomeRates: false,
            note: `No per-evidence outcome history supplied; fell back to the highest recorded department, district, or project-type delay rate (${score.toFixed(2)}).`,
        };
    }
    return { score: 0, usedOutcomeRates: false, note: 'No historical pattern data was supplied; historical support scored 0.' };
};
const decidePriority = (entry, rankingScore, input, related, targetDate, asOfAt) => {
    const overrides = [];
    let priority = bandFor(rankingScore);
    if (input.prediction.riskLevel === 'CRITICAL' &&
        related !== null &&
        related.rank !== null &&
        related.rank <= ENGINE_LIMITS.topFactorRankForOverride) {
        const raised = higherPriority(priority, 'HIGH');
        if (raised !== priority) {
            overrides.push(`CRITICAL_RISK_TOP_FACTOR: project risk level is CRITICAL and this action addresses model factor #${related.rank}; priority raised to at least HIGH.`);
            priority = raised;
        }
    }
    if (entry.impactCategory === 'SCHEDULE_RECOVERY' && targetDate && daysBetween(asOfAt, targetDate) <= 0) {
        const raised = higherPriority(priority, 'HIGH');
        if (raised !== priority) {
            overrides.push('SCHEDULE_BREACH: the project target date has passed; schedule-recovery priority raised to at least HIGH.');
            priority = raised;
        }
    }
    const degraded = input.prediction.predictionStatus === 'RULE_ONLY_FALLBACK' ||
        input.prediction.predictionStatus === 'STALE' ||
        input.prediction.confidenceBand === 'LOW';
    if (degraded && !CODE_POLICY[entry.code].hardStop) {
        const capped = lowerPriority(priority, 'HIGH');
        if (capped !== priority) {
            overrides.push(`DEGRADED_PREDICTION_CAP: prediction status is ${input.prediction.predictionStatus ?? 'OK'} with confidence band ${input.prediction.confidenceBand ?? 'UNKNOWN'}; priority capped at HIGH.`);
            priority = capped;
        }
    }
    if (CODE_POLICY[entry.code].hardStop) {
        if (priority !== 'CRITICAL') {
            overrides.push('HARD_STOP_POLICY: governed hard-stop condition; priority set to CRITICAL regardless of ranking score.');
        }
        priority = 'CRITICAL';
    }
    return { priority, basis: overrides.length > 0 ? 'POLICY_OVERRIDE' : 'RANKING_SCORE', overrides };
};
const computeDeadline = (entry, priority, workload, asOfAt, targetDate) => {
    const baseSlaDays = CODE_POLICY[entry.code].slaDays;
    const urgencyFactor = DEADLINE_URGENCY_FACTOR[priority];
    const workloadIndex = workload && isNumber(workload.workloadIndex) ? clamp(workload.workloadIndex) : 0;
    const workloadFactor = 1 + ENGINE_LIMITS.workloadDeadlineCoefficient * workloadIndex;
    const upperBound = Math.min(ENGINE_LIMITS.maxDeadlineDays, baseSlaDays * 2);
    let days = Math.round(baseSlaDays * urgencyFactor * workloadFactor);
    days = Math.min(upperBound, Math.max(ENGINE_LIMITS.minDeadlineDays, days));
    const reasons = [
        `${baseSlaDays}-day policy service window for ${entry.code}`,
        `${priority} priority factor ${urgencyFactor}`,
        workload
            ? `responsible department workload index ${workloadIndex.toFixed(2)} (factor ${workloadFactor.toFixed(2)})`
            : 'no workload recorded for the responsible department (factor 1.00)',
    ];
    if (targetDate) {
        const daysToTarget = Math.floor(daysBetween(asOfAt, targetDate));
        if (daysToTarget >= ENGINE_LIMITS.minDeadlineDays && daysToTarget < days) {
            days = daysToTarget;
            reasons.push(`shortened to the project target date, ${daysToTarget} day(s) away`);
        }
    }
    return {
        days,
        dueAt: new Date(asOfAt.getTime() + days * MS_PER_DAY).toISOString(),
        baseSlaDays,
        basis: `Derived from ${reasons.join('; ')}.`,
    };
};
const decideStatus = (code, existing) => {
    const previous = existing.get(code);
    if (!previous)
        return { status: 'OPEN', basis: 'Newly generated from evidence at this snapshot.' };
    if (previous.status === 'DISMISSED') {
        return { status: 'DISMISSED', basis: 'An authorized official dismissed this recommendation; the decision is retained.' };
    }
    if (TERMINAL_STATUSES.has(previous.status)) {
        return {
            status: 'OPEN',
            basis: `Previously ${previous.status}, reopened because the evidence is present again at this snapshot.`,
        };
    }
    return { status: previous.status, basis: `Carried over from the stored recommendation, last recorded as ${previous.status}.` };
};
export const generateRecommendations = (input, options = {}) => {
    const asOfAt = toDate(input.asOfAt) ?? new Date();
    const generatedAt = toDate(options.generatedAt) ?? asOfAt;
    const maxRecommendations = options.maxRecommendations ?? ENGINE_LIMITS.maxRecommendations;
    const metrics = input.project.metrics ?? {};
    const milestone = input.currentMilestone ?? null;
    const pendingTasks = input.pendingTasks ?? [];
    const workloads = input.departmentWorkload ?? [];
    const riskFactors = (input.topRiskFactors ?? []).filter((factor) => Boolean(factor?.factorCode));
    const targetDate = toDate(input.project.targetDate);
    const horizonDays = isNumber(input.prediction.horizonDays) && input.prediction.horizonDays > 0
        ? input.prediction.horizonDays
        : ENGINE_LIMITS.defaultHorizonDays;
    const pendingTaskByCode = new Map();
    for (const task of pendingTasks) {
        if (task?.taskCode)
            pendingTaskByCode.set(normalizeFactorCode(task.taskCode), task);
    }
    const workloadByDepartment = new Map();
    for (const workload of workloads) {
        if (workload?.department)
            workloadByDepartment.set(workload.department, workload);
    }
    const existingByCode = new Map();
    for (const existing of input.existingRecommendations ?? []) {
        if (existing?.evidenceCode)
            existingByCode.set(normalizeFactorCode(existing.evidenceCode), existing);
    }
    const context = {
        asOfAt,
        project: input.project,
        metrics,
        milestone,
        prediction: input.prediction,
        pendingTaskByCode,
        workloadByDepartment,
        historicalPatterns: input.historicalPatterns ?? null,
        milestoneOverdueDays: deriveMilestoneOverdueDays(milestone, metrics.overdueDays, asOfAt),
    };
    const factorIndex = indexRiskFactors(riskFactors);
    const predictedRisk = clamp(isNumber(input.prediction.riskScore) ? input.prediction.riskScore : input.prediction.delayProbability);
    const dataOrigin = input.project.dataOrigin ?? null;
    const predictionStatus = input.prediction.predictionStatus ?? 'OK';
    const suppressed = [];
    const scored = [];
    for (const entry of CATALOG) {
        let partial;
        try {
            partial = entry.extract(context);
        }
        catch (error) {
            suppressed.push({
                evidenceCode: entry.code,
                reason: 'INPUT_UNAVAILABLE',
                detail: `Evidence extraction failed: ${error.message}`,
            });
            continue;
        }
        if (!partial) {
            suppressed.push({
                evidenceCode: entry.code,
                reason: 'NO_EVIDENCE',
                detail: `No measured value for ${entry.featureCodes.join(', ')} was present in the supplied inputs.`,
            });
            continue;
        }
        const evidence = buildObservation(entry, partial, context);
        if (evidence.severity < ENGINE_LIMITS.materialitySeverity) {
            suppressed.push({
                evidenceCode: entry.code,
                reason: 'BELOW_MATERIALITY_THRESHOLD',
                detail: `Severity ${evidence.severity.toFixed(3)} is below the ${ENGINE_LIMITS.materialitySeverity} materiality threshold (${evidence.description}).`,
            });
            continue;
        }
        const linkage = computeModelLinkage(entry, factorIndex);
        const urgency = computeUrgency(entry, context, horizonDays, targetDate);
        const historical = computeHistoricalSupport(entry.code, context);
        const policyWeight = CODE_POLICY[entry.code].weight;
        const rankingScore = round(RANKING_WEIGHTS.evidenceSeverity * evidence.severity +
            RANKING_WEIGHTS.modelLinkage * linkage.score +
            RANKING_WEIGHTS.urgency * urgency.score +
            RANKING_WEIGHTS.policyWeight * policyWeight +
            RANKING_WEIGHTS.predictedRisk * predictedRisk +
            RANKING_WEIGHTS.historicalSupport * historical.score);
        const decision = decidePriority(entry, rankingScore, input, linkage.related, targetDate, asOfAt);
        const department = entry.department(context);
        const workload = workloadByDepartment.get(department.name);
        const deadline = computeDeadline(entry, decision.priority, workload, asOfAt, targetDate);
        const status = decideStatus(entry.code, existingByCode);
        const relatedRiskFactor = linkage.related ?? {
            factorCode: entry.code,
            label: entry.label,
            direction: 'INCREASES_RISK',
            relativeContribution: null,
            rank: null,
            source: 'RULE',
            evidenceAt: evidence.observedAt,
        };
        const limitations = [...BASE_LIMITATIONS];
        if (predictionStatus !== 'OK') {
            limitations.push(`Prediction status is ${predictionStatus}; the model contribution to this ranking is unreliable or absent.`);
        }
        if (input.prediction.confidenceBand === 'LOW') {
            limitations.push('Prediction confidence for this project is LOW.');
        }
        if (!linkage.related) {
            limitations.push('No model risk factor was linked to this evidence; the action rests on rule evidence alone.');
        }
        if (!historical.usedOutcomeRates) {
            limitations.push('No validated outcome history was available for this evidence code.');
        }
        if (dataOrigin === 'SYNTHETIC_DEMO') {
            limitations.push('Underlying data is marked SYNTHETIC_DEMO and must not support an official decision.');
        }
        if (decision.basis === 'POLICY_OVERRIDE') {
            limitations.push('The final priority was set by a policy override, not by the ranking score alone.');
        }
        const capacityNote = workload && isNumber(workload.workloadIndex) && workload.workloadIndex >= ENGINE_LIMITS.workloadEscalationThreshold
            ? `${department.name} is at a workload index of ${clamp(workload.workloadIndex, 0, 2).toFixed(2)}; the suggested deadline already allows for this load.`
            : null;
        const scoreBreakdown = {
            evidenceSeverity: round(evidence.severity),
            modelLinkage: round(linkage.score),
            urgency: round(urgency.score),
            policyWeight: round(policyWeight),
            predictedRisk: round(predictedRisk),
            historicalSupport: round(historical.score),
            weights: { ...RANKING_WEIGHTS },
            notes: [
                `Evidence severity from ${evidence.severityFunction}.`,
                linkage.note,
                ...urgency.notes,
                historical.note,
                `Predicted risk component used ${isNumber(input.prediction.riskScore) ? 'the governed risk score' : 'the calibrated delay probability'} (${predictedRisk.toFixed(2)}).`,
                `Policy weight ${policyWeight} for ${entry.code} under ${POLICY_VERSION}.`,
            ],
        };
        scored.push({
            recommendationId: `rec_${fingerprint(`${input.project.projectId}|${entry.code}|${POLICY_VERSION}|${CATALOG_VERSION}`)}`,
            rank: 0,
            priority: decision.priority,
            priorityBasis: decision.basis,
            appliedOverrides: decision.overrides,
            action: renderAction(entry.action(evidence, context)),
            reason: renderReason(entry.reason(evidence, context)),
            relatedRiskFactor,
            responsibleDepartment: department.name,
            departmentBasis: department.basis,
            suggestedDeadline: deadline,
            expectedImpact: renderImpact(entry.impact(evidence, context)),
            impactCategory: entry.impactCategory,
            status: status.status,
            statusBasis: status.basis,
            rankingScore,
            scoreBreakdown,
            evidence,
            capacityNote,
            limitations,
        });
    }
    // Priority first, because a policy override must outrank a higher raw score.
    // Within a band a governed hard stop comes first: an officer has to see a
    // legal constraint before an action that the constraint may forbid.
    scored.sort((left, right) => {
        const byPriority = PRIORITY_ORDER[right.priority] - PRIORITY_ORDER[left.priority];
        if (byPriority !== 0)
            return byPriority;
        const byHardStop = Number(CODE_POLICY[right.evidence.code].hardStop ?? false) - Number(CODE_POLICY[left.evidence.code].hardStop ?? false);
        if (byHardStop !== 0)
            return byHardStop;
        if (right.rankingScore !== left.rankingScore)
            return right.rankingScore - left.rankingScore;
        const byWeight = CODE_POLICY[right.evidence.code].weight - CODE_POLICY[left.evidence.code].weight;
        if (byWeight !== 0)
            return byWeight;
        const bySla = CODE_POLICY[left.evidence.code].slaDays - CODE_POLICY[right.evidence.code].slaDays;
        if (bySla !== 0)
            return bySla;
        return left.evidence.code.localeCompare(right.evidence.code);
    });
    const emitted = scored.slice(0, maxRecommendations);
    for (const overflow of scored.slice(maxRecommendations)) {
        suppressed.push({
            evidenceCode: overflow.evidence.code,
            reason: 'BELOW_RANK_CUTOFF',
            detail: `Ranked below the ${maxRecommendations}-action cutoff with a score of ${overflow.rankingScore} (${overflow.priority}).`,
        });
    }
    emitted.forEach((recommendation, index) => {
        recommendation.rank = index + 1;
    });
    const missingInputBlocks = [];
    if (riskFactors.length === 0)
        missingInputBlocks.push('topRiskFactors');
    if (!input.historicalPatterns)
        missingInputBlocks.push('historicalPatterns');
    if (pendingTasks.length === 0)
        missingInputBlocks.push('pendingTasks');
    if (workloads.length === 0)
        missingInputBlocks.push('departmentWorkload');
    if (Object.keys(metrics).length === 0)
        missingInputBlocks.push('project.metrics');
    if (!milestone)
        missingInputBlocks.push('currentMilestone');
    const warnings = [];
    if (missingInputBlocks.length > 0) {
        warnings.push(`Ranking used partial inputs; the following blocks were not supplied: ${missingInputBlocks.join(', ')}.`);
    }
    if (predictionStatus !== 'OK') {
        warnings.push(`Prediction status is ${predictionStatus}; model-derived ranking components are degraded.`);
    }
    if (dataOrigin === 'SYNTHETIC_DEMO') {
        warnings.push('Project data origin is SYNTHETIC_DEMO.');
    }
    const byPriority = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
    for (const recommendation of emitted)
        byPriority[recommendation.priority] += 1;
    return {
        projectId: input.project.projectId,
        asOfAt: asOfAt.toISOString(),
        generatedAt: generatedAt.toISOString(),
        policyVersion: POLICY_VERSION,
        catalogVersion: CATALOG_VERSION,
        currentMilestone: milestone?.name ?? null,
        riskLevel: input.prediction.riskLevel,
        delayProbability: input.prediction.delayProbability,
        recommendations: emitted,
        suppressed,
        dataQuality: {
            dataOrigin,
            predictionStatus,
            confidenceBand: input.prediction.confidenceBand ?? null,
            missingInputBlocks,
            warnings,
        },
        summary: { evaluatedCodes: CATALOG.length, emitted: emitted.length, byPriority },
        limitations: [...BASE_LIMITATIONS],
    };
};
/** Traceability envelope for one recommendation, used by audit and API layers. */
export const traceabilityFor = (recommendation, result, prediction) => ({
    evidenceCode: recommendation.evidence.code,
    featureCodes: recommendation.evidence.featureCodes,
    inputSources: [recommendation.evidence.source],
    modelVersion: prediction.modelVersion ?? null,
    predictionId: prediction.predictionId ?? null,
    policyVersion: result.policyVersion,
    catalogVersion: result.catalogVersion,
    dataOrigin: result.dataQuality.dataOrigin,
    generatedAt: result.generatedAt,
});
