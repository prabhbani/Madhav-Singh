# Recommendation Engine

The recommendation engine is the action layer that sits after the prediction and
explanation layers. It converts measured case evidence and model output into a
ranked list of operational actions, each one traceable back to the value that
produced it.

```text
project data      current milestone      risk score / delay probability
pending tasks     department workload    top risk factors
historical patterns
        |
        v
  evidence extraction  (catalogue: one extractor per evidence code)
        |
        v
  materiality filter   (severity below policy threshold is recorded, not emitted)
        |
        v
  component scoring    (severity, model linkage, urgency, policy, risk, history)
        |
        v
  priority decision    (bands, then documented overrides)
        |
        v
  deadline, department, status, limitations
        |
        v
  ranked recommendations + suppression report
```

The engine has one governing rule: **an action exists only because a measured
value exists**. There is no generative step, no free-text advice, and no action
that cannot name the column it came from.

## 1. Where it lives

| Concern | File |
|---|---|
| Input and output contract | `backend/src/recommendations/types.ts` |
| Versioned thresholds, weights, severity functions | `backend/src/recommendations/policy.ts` |
| Evidence catalogue and text templates | `backend/src/recommendations/catalog.ts` |
| Controlled-language guard | `backend/src/recommendations/wording.ts` |
| Scoring, ranking, priority, deadlines | `backend/src/recommendations/engine.ts` |
| Database assembly and persistence | `backend/src/services/recommendationService.ts` |
| Tests | `backend/test/recommendationEngine.test.ts` |

`generateRecommendations(input)` is pure and deterministic. It performs no
database, clock, or network access, so the same snapshot always produces the same
ranked list. Every database concern lives in the service layer above it.

## 2. Inputs

| Block | Supplies | Required |
|---|---|---|
| `project` | Identity, owning department, target date, data origin, and measured metrics that mirror the ML feature columns | yes |
| `currentMilestone` | Name, planned date, owner department, overdue age | no |
| `prediction` | Risk level, calibrated delay probability, governed risk score, horizon, confidence band, prediction status, model version | yes |
| `topRiskFactors` | Ranked model or rule factors with direction and relative contribution | no |
| `historicalPatterns` | Per-evidence outcome rates with sample sizes, median resolution days, and department/district/project-type delay rates | no |
| `pendingTasks` | Operational queues by task code, with counts, owner department, and oldest item age | no |
| `departmentWorkload` | Normalized workload index, open items, and active projects per department | no |
| `existingRecommendations` | Stored status per evidence code, so officer decisions survive regeneration | no |

Optional blocks are genuinely optional. When one is absent the engine names it in
`dataQuality.missingInputBlocks`, scores its component as zero, and says so in the
score notes. It never imputes a value and then reports full confidence.

Where both a pending-task queue and a stored project metric carry the same count,
the queue wins, because it is the operational record an officer acts on. The
emitted evidence records which of the two it used in `evidence.source`.

## 3. Evidence catalogue

Fifteen evidence codes are defined. Each maps to specific dataset columns and to
the model factor codes that represent the same operational issue.

| Evidence code | Read from | Default responsible department | Policy weight | SLA |
|---|---|---|---:|---:|
| `ACTIVE_STAY_ORDER` | `stay_order_flag` | Legal Department | 1.00 | 3d |
| `OWNERSHIP_UNRESOLVED` | `unresolved_record_count`, `disputed_ownership_flag` | Land Records Department | 0.90 | 14d |
| `MILESTONE_OVERDUE` | `overdue_days`, milestone `planned_at` | Milestone owner, else project department | 0.86 | 7d |
| `COMPENSATION_PENDING` | `payment_processing_days`, `pending_compensation_amount` | Finance and Compensation Department | 0.85 | 15d |
| `OPEN_LEGAL_CASE_COUNT` | `open_legal_case_count`, `legal_dispute_flag` | Legal Department | 0.82 | 10d |
| `PENDING_APPROVAL_COUNT` | `pending_approval_count` | Project department | 0.80 | 7d |
| `OPEN_OBJECTION_COUNT` | `unresolved_objection_count` | Land Acquisition Cell | 0.78 | 21d |
| `MISSING_DOCUMENT_COUNT` | `missing_document_count` | Revenue Department | 0.75 | 10d |
| `BLOCKED_DEPENDENCY_COUNT` | `blocked_dependency_count` | District Administration | 0.72 | 12d |
| `MILESTONE_SLIPPAGE_COUNT` | `milestone_slippage_count` | Project department | 0.70 | 14d |
| `STAGE_AGING` | `days_in_current_stage` vs `average_stage_duration_days` | Milestone owner, else project department | 0.68 | 14d |
| `INVALID_DOCUMENT_COUNT` | `invalid_document_count` | Revenue Department | 0.62 | 12d |
| `DEPARTMENT_CAPACITY` | `department_workload_index` | Most loaded department | 0.60 | 21d |
| `DOCUMENT_VERIFICATION_PENDING` | `document_verification_pending_count` | Revenue Department | 0.55 | 14d |
| `STALE_CASE_DATA` | `days_since_last_update` | Project department | 0.45 | 5d |

A task-queue record with a recorded `ownerDepartment`, or a milestone with a
recorded `ownerDepartment`, overrides the default. The emitted
`departmentBasis` states which rule assigned the department.

### Severity functions

Severity normalizes a raw measurement into `[0,1]` against a policy threshold. It
is not a probability and is never presented as one.

```text
ratioSeverity(value, threshold)          = clamp(value / threshold)
sigmoidSeverity(value, tolerance, scale) = clamp(1 / (1 + exp(-(value - tolerance) / scale)))
baselineRatioSeverity(value, baseline)   = clamp(value / baseline - 1)
flagSeverity(flag)                       = flag ? 1 : 0
```

Counts use `ratioSeverity`. Ageing measures use `sigmoidSeverity`, which reaches
0.5 at the tolerance point. Stage age uses `baselineRatioSeverity` against the
historical stage baseline rather than a universal day count. `flagSeverity`
returns 1.0 only for a governed hard stop.

Evidence whose severity falls below the materiality threshold of 0.12 is recorded
in `suppressed` with its measured value, rather than discarded.

## 4. Ranking

The ranking score is a weighted sum of six components, each in `[0,1]`. The
weights sum to 1, so the score stays in `[0,1]` and is comparable across
projects.

| Component | Weight | Source |
|---|---:|---|
| Evidence severity | 0.30 | Measured value against its policy threshold |
| Model linkage | 0.22 | Summed relative contribution of linked risk factors |
| Urgency | 0.18 | Strongest of target-date, milestone-overdue, task-age, and task-due pressure |
| Policy weight | 0.15 | Approved base importance of the evidence code |
| Predicted risk | 0.09 | Governed risk score, or the calibrated delay probability |
| Historical support | 0.06 | Outcome lift for this evidence in completed cases |

Every recommendation returns `scoreBreakdown` with all six component values, the
weights used, and a note explaining each one. The score reconciles with its own
breakdown, and a test asserts that it does.

Model linkage counts only factors whose direction is not `REDUCES_RISK`: a factor
that lowers predicted risk must not raise the urgency of an action. When the
caller supplies no relative contributions, a documented linear rank decay is used
instead and the note says so. When no model factor matches the evidence at all,
the component scores zero and the recommendation carries a limitation saying the
action rests on rule evidence alone.

Historical support uses per-evidence outcome rates only when the sample reaches 30
completed cases. Below that it scores zero and reports why, rather than ranking on
a handful of observations. With no per-evidence history it falls back to the
highest recorded department, district, or project-type delay rate.

### Priority

Bands are applied to the ranking score, then documented overrides are applied in
a fixed order.

| Band | Ranking score |
|---|---:|
| CRITICAL | `>= 0.72` |
| HIGH | `>= 0.52` |
| MEDIUM | `>= 0.32` |
| LOW | `< 0.32` |

| Override | Effect |
|---|---|
| `CRITICAL_RISK_TOP_FACTOR` | Project risk is CRITICAL and the action addresses a top-3 model factor: raise to at least HIGH |
| `SCHEDULE_BREACH` | Project target date has passed and the action is schedule recovery: raise to at least HIGH |
| `DEGRADED_PREDICTION_CAP` | Prediction is stale, rule-only, or LOW confidence: cap at HIGH, so a degraded model cannot drive a CRITICAL action |
| `HARD_STOP_POLICY` | Governed hard stop such as an active stay order: set CRITICAL, applied last |

Any override sets `priorityBasis` to `POLICY_OVERRIDE`, lists itself in
`appliedOverrides`, and adds a limitation stating that the priority was not set by
the ranking score alone.

Sorting is by priority, then hard stop, then ranking score, then policy weight,
then SLA, then evidence code. Hard stops sort above other actions in the same
band because an officer has to see a legal constraint before an action that the
constraint may forbid. The final tiebreak on evidence code keeps output stable.

### Suggested deadline

```text
days = round(baseSlaDays * urgencyFactor[priority] * (1 + 0.5 * workloadIndex))
days = clamp(days, 2, min(90, baseSlaDays * 2))
days = min(days, daysToProjectTarget)   when the target is nearer and at least 2 days away
```

Urgency factors are 0.4 for CRITICAL, 0.65 for HIGH, 1.0 for MEDIUM, and 1.25 for
LOW. Workload lengthens the deadline rather than shortening it: a saturated
department is given a deadline it can meet, and the reason is stated in
`suggestedDeadline.basis`. Workload never lowers an action's priority, because
the urgency of the bottleneck does not change when the queue is busy. A separate
`DEPARTMENT_CAPACITY` action is raised instead.

### Status

| Stored status | On regeneration |
|---|---|
| none | `OPEN` |
| `ACKNOWLEDGED`, `ASSIGNED`, `IN_PROGRESS` | carried over unchanged |
| `DISMISSED` | stays dismissed; an official's decision is retained |
| `COMPLETED`, `EXPIRED` | reopened as `OPEN`, because the evidence is present again |

Evidence that no longer appears causes any stored open recommendation for that
code to be marked `EXPIRED`, so a cleared bottleneck leaves the officer's queue.

## 5. Controlled language

All three rendered fields pass through `wording.ts` before they leave the engine.
The renderer rejects causal verbs and certainty claims outright, including
"cause", "results in", "leads to", "will reduce", "guarantee", "ensure",
"eliminate", and "prevent". A reason must additionally contain a hedged
connector, and an expected impact must contain a hedged qualifier. A template
that fails either check throws `WordingViolationError` rather than reaching an
officer's screen.

Accepted phrasing: "is recommended because", "is associated with", "may reduce",
"could help mitigate".

## 6. Worked example

Input: 23 parcels with unresolved ownership records in a pending-task queue owned
by the Land Records Department, oldest item 58 days old; the milestone is 26 days
overdue; the model ranks `unresolved_record_count` first with a relative
contribution of 0.31; 420 completed cases show a 71% delay rate with this
evidence against 28% without it; the responsible department reports a workload
index of 0.91.

```text
CRITICAL PRIORITY

Action:
Complete ownership verification for the 23 parcels with unresolved records.

Reason:
Ownership verification is currently incomplete for 23 parcels and is associated
with elevated predicted delay risk for this project. Comparable completed cases
cleared this item in a median of 26 days.

Related risk factor:
UNRESOLVED_RECORD_COUNT (ML, rank 1, relative contribution 0.31)

Responsible:
Land Records Department

Suggested deadline:
8 days (by 2026-09-23)

Expected impact:
May reduce the administrative bottleneck in title verification and could help
mitigate downstream compensation and possession delays.

Status:
OPEN
```

Ranking score 0.7702, reconciling from its own breakdown:

| Component | Value | Weight | Contribution |
|---|---:|---:|---:|
| Evidence severity | 1.00 | 0.30 | 0.3000 |
| Model linkage | 0.31 | 0.22 | 0.0682 |
| Urgency | 1.00 | 0.18 | 0.1800 |
| Policy weight | 0.90 | 0.15 | 0.1350 |
| Predicted risk | 0.68 | 0.09 | 0.0612 |
| Historical support | 0.43 | 0.06 | 0.0258 |
| **Total** | | | **0.7702** |

The deadline of 8 days is 14 base SLA days times the 0.4 CRITICAL factor times
the 1.455 workload factor, which the response states in full.

## 7. API

```http
POST   /api/v1/projects/{id}/recommendations     Run the engine and store the ranked actions
GET    /api/v1/projects/{id}/recommendations     Stored recommendations in rank order
PATCH  /api/v1/recommendations/{id}/status       Record an officer decision
GET    /api/v1/recommendations/policy-versions   Active policy and catalogue versions
```

The POST body accepts an optional `snapshot` carrying `metrics`, `pendingTasks`,
`departmentWorkload`, `historicalPatterns`, and `topRiskFactors`. Supplied values
take precedence over values derived from the operational tables, which lets a
richer ML feature snapshot drive the engine without changing it. Generation is
restricted to officer roles; reading is available to any authenticated user
within scope.

### Derived inputs

When a block is not supplied, the service derives what the operational schema can
actually evidence, and nothing beyond it:

- **Metrics** come from the document, milestone, and project rows: missing,
  invalid, and unverified document counts, overdue and slippage counts, current
  stage age, average completed stage duration, and record staleness.
- **Department workload** is open items against an assumed capacity of six items
  per active project, with a floor. The index is absolute, not relative to the
  busiest department, so a quiet system does not report a saturated one.
- **Historical patterns** are overdue-milestone rates by department, district, and
  project type. Per-evidence outcome rates are not derived, because the simplified
  operational schema does not record completed-case outcomes; the engine reports
  the fallback it used.

## 8. Persistence

Each emitted action is upserted on `(project_id, evidence_code)`, so regeneration
updates an existing row rather than accumulating duplicates. A stored status is
never overwritten by a regeneration. The full engine envelope, including evidence,
score breakdown, deadline basis, applied overrides, and limitations, is stored in
the `detail` column alongside the policy, catalogue, and model versions, so a past
recommendation can be audited against the policy that produced it.

Schema change: the `recommendations` table gains `evidence_code`, `rank`,
`ranking_score`, `priority_basis`, `responsible_department`, `expected_impact`,
`related_factor_code`, `source`, `policy_version`, `catalog_version`,
`model_version`, `prediction_id`, `detail`, and `updated_at`, plus a unique index
on `(project_id, evidence_code)`. Run `npm run prisma:migrate` before deploying.

## 9. Governance

- Recommendations are suggestions. An authorized official accepts, edits,
  assigns, or dismisses them; the engine records the decision and does not
  overturn it.
- Every recommendation carries limitations, always including that the finding is
  a predictive association rather than a causal one.
- Data marked `SYNTHETIC_DEMO` is flagged on every recommendation it produces.
- Every considered evidence code appears in either `recommendations` or
  `suppressed`, so nothing is dropped without a recorded reason.
- Changing a threshold, weight, or SLA is a change to `policy.ts` and should ship
  with a new `POLICY_VERSION`, because stored recommendations reference it.

## 10. Tests

`backend/test/recommendationEngine.test.ts` covers evidence gating, the
suppression report, score reconciliation against the published breakdown, ranking
order, model-factor linkage and direction handling, every priority override,
deadline derivation under load, outcome-history sample gating, status retention,
determinism, rank cutoff, missing-input reporting, and the controlled-language
guard.

```bash
cd backend && npm test
```
