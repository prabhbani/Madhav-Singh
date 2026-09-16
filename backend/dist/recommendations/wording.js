/**
 * Controlled language for recommendation text.
 *
 * The engine reports association, never causation, and never promises an
 * outcome. Rendering goes through this module so a banned phrase cannot reach an
 * officer's screen even if a template is edited carelessly later.
 */
/** Phrases that assert causality or certainty. Rejected in every rendered field. */
const BANNED_PATTERNS = [
    { pattern: /\bcaus(e|es|ed|ing)\b/i, label: 'causal verb "cause"' },
    { pattern: /\bresult(s|ed)\s+in\b/i, label: 'causal phrase "results in"' },
    { pattern: /\blead(s)?\s+to\b/i, label: 'causal phrase "leads to"' },
    { pattern: /\bwill\s+(reduce|prevent|remove|fix|resolve|avoid|eliminate|cut)\b/i, label: 'certainty claim "will ..."' },
    { pattern: /\bguarantee(s|d)?\b/i, label: 'certainty claim "guarantee"' },
    { pattern: /\bensur(e|es|ed|ing)\b/i, label: 'certainty claim "ensure"' },
    { pattern: /\bdefinitely\b/i, label: 'certainty claim "definitely"' },
    { pattern: /\bcertainly\b/i, label: 'certainty claim "certainly"' },
    { pattern: /\beliminat(e|es|ed)\b/i, label: 'certainty claim "eliminate"' },
    { pattern: /\bprevent(s|ed)\b/i, label: 'certainty claim "prevent"' },
    { pattern: /\bproven\s+to\b/i, label: 'certainty claim "proven to"' },
];
/** At least one of these must appear in a reason, so the link stays hedged. */
const REASON_HEDGES = [
    /\bis recommended because\b/i,
    /\bis associated with\b/i,
    /\bare associated with\b/i,
    /\bmay\b/i,
    /\bcould\b/i,
];
/** At least one of these must appear in an expected-impact statement. */
const IMPACT_HEDGES = [
    /\bmay\b/i,
    /\bcould\b/i,
    /\bis intended to\b/i,
    /\bsupports\b/i,
];
export class WordingViolationError extends Error {
    field;
    violation;
    text;
    constructor(field, violation, text) {
        super(`Recommendation ${field} violates controlled language policy (${violation}): "${text}"`);
        this.field = field;
        this.violation = violation;
        this.text = text;
        this.name = 'WordingViolationError';
    }
}
const findBanned = (text) => {
    for (const { pattern, label } of BANNED_PATTERNS) {
        if (pattern.test(text))
            return label;
    }
    return null;
};
const hasHedge = (text, hedges) => hedges.some((hedge) => hedge.test(text));
/** Rejects causal or absolute wording in any rendered field. */
export const assertNonCausal = (field, text) => {
    const violation = findBanned(text);
    if (violation)
        throw new WordingViolationError(field, violation, text);
    return text;
};
/** An action is an imperative instruction; it only has to avoid banned wording. */
export const renderAction = (text) => assertNonCausal('action', text.trim());
/** A reason must avoid banned wording and must carry an explicit hedge. */
export const renderReason = (text) => {
    const trimmed = text.trim().replace(/\s+/g, ' ');
    assertNonCausal('reason', trimmed);
    if (!hasHedge(trimmed, REASON_HEDGES)) {
        throw new WordingViolationError('reason', 'missing hedged connector', trimmed);
    }
    return trimmed;
};
/** An expected impact must be phrased as a possible effect, never a promise. */
export const renderImpact = (text) => {
    const trimmed = text.trim().replace(/\s+/g, ' ');
    assertNonCausal('expectedImpact', trimmed);
    if (!hasHedge(trimmed, IMPACT_HEDGES)) {
        throw new WordingViolationError('expectedImpact', 'missing hedged qualifier', trimmed);
    }
    return trimmed;
};
/** Standard association clause reused by every reason template. */
export const ASSOCIATION_CLAUSE = 'is associated with elevated predicted delay risk for this project';
/** Limitations attached to every recommendation, per the explainability policy. */
export const BASE_LIMITATIONS = [
    'This is a predictive association, not a causal finding.',
    'The result depends on the completeness and freshness of recorded case data.',
    'Recommendations are suggestions; an authorized official decides whether to act.',
];
export const formatCount = (value, unit) => {
    const rounded = Number.isInteger(value) ? value : Number(value.toFixed(2));
    const plural = Math.abs(rounded) === 1 || unit.endsWith('s') ? unit : `${unit}s`;
    return `${rounded} ${plural}`;
};
