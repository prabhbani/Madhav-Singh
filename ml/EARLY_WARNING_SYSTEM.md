# Early Warning System

The early warning system watches every active project for eleven conditions and
raises an alert when one crosses a policy threshold. It sits beside the
recommendation engine: recommendations answer "what should be done", alerts
answer "what changed that an officer needs to see now".

```text
project data      milestones        prediction + prediction history
observation history                 department workload
        |
        v
  eleven detectors     (one measured condition each)
        |
        v
  severity ladder      (INFO / WARNING / HIGH / CRITICAL, then overrides)
        |
        v
  correlation control  (one underlying signal pages once)
        |
        v
  deduplication        (unchanged condition never re-raises)
        |
        v
  cooldown + budget    (escalation always breaks the cooldown)
        |
        v
  alerts, notifications, resolutions, suppression report
```

The system is designed around one failure mode: an early warning system that
pages too often gets ignored, and an ignored system is worse than none. Most of
the engine is therefore about deciding *not* to notify.

## 1. Where it lives

| Concern | File |
|---|---|
| Input and output contract | `backend/src/alerts/types.ts` |
| Thresholds, ladders, cooldowns, budget | `backend/src/alerts/policy.ts` |
| The eleven detectors | `backend/src/alerts/detectors.ts` |
| Decisions, dedup, cooldown, correlation | `backend/src/alerts/engine.ts` |
| Database assembly, persistence, history | `backend/src/services/alertService.ts` |
| Derivations shared with recommendations | `backend/src/services/caseSnapshot.ts` |
| Tests | `backend/test/alertEngine.test.ts` |

`evaluateAlerts(input)` is pure and deterministic. The service layer holds every
database concern, so the decision logic can be tested without a database and
gives identical output for identical input.

## 2. Detectors

Each detector reads named measurements and returns a condition or nothing. A
detector never decides whether an officer is notified.

| Alert type | Measures | Read from | Responsible department |
|---|---|---|---|
| `MILESTONE_DEADLINE_APPROACHING` | Days until the soonest open milestone | milestone plan date | Milestone owner, else project department |
| `MILESTONE_OVERDUE` | Days past the milestone plan date | `overdue_days` | Milestone owner, else project department |
| `RISK_TREND_INCREASING` | Rise in delay probability across a window | prediction history | Project department |
| `HIGH_DELAY_PROBABILITY` | Calibrated delay probability | current prediction | Project department |
| `CRITICAL_RISK_LEVEL` | Governed CRITICAL classification | current prediction | Project department |
| `RISK_SCORE_JUMP` | Single-step rise against the previous prediction | prediction history | Project department |
| `COMPENSATION_BACKLOG` | Days in payment processing | `payment_processing_days` | Finance and Compensation |
| `OBJECTIONS_INCREASING` | Net rise in unresolved objections | observation history | Land Acquisition Cell |
| `LEGAL_ISSUE` | Stay order, then open case count | `stay_order_flag`, `open_legal_case_count` | Legal Department |
| `DOCUMENT_VERIFICATION_BACKLOG` | Documents awaiting verification | `document_verification_pending_count` | Revenue Department |
| `DEPARTMENT_WORKLOAD_OVERLOAD` | Normalized workload index | `department_workload_index` | Most loaded department |

### Trend versus jump

These two are deliberately separate signals, not duplicates.

- `RISK_SCORE_JUMP` compares the newest prediction against the one immediately
  before it, within 21 days. It catches a step change.
- `RISK_TREND_INCREASING` compares the newest against the oldest inside a 45-day
  window, requires at least three points, and requires at least 60% of the steps
  to rise. It catches a sustained climb and ignores a single spike inside an
  otherwise flat series.

Both belong to the `RISK_MOVEMENT` correlation group, so they page once.

## 3. Severity

Every detector maps its measured value onto a four-rung ladder. `ASCENDING`
ladders fire at or above a rung, `DESCENDING` ladders at or below one.

| Alert type | INFO | WARNING | HIGH | CRITICAL |
|---|---:|---:|---:|---:|
| `MILESTONE_DEADLINE_APPROACHING` (days left) | 14 | 7 | 3 | 1 |
| `MILESTONE_OVERDUE` (days) | 1 | 7 | 21 | 45 |
| `RISK_TREND_INCREASING` (probability rise) | 0.05 | 0.10 | 0.18 | 0.28 |
| `HIGH_DELAY_PROBABILITY` | 0.50 | 0.60 | 0.75 | 0.85 |
| `RISK_SCORE_JUMP` (probability rise) | 0.05 | 0.08 | 0.12 | 0.20 |
| `COMPENSATION_BACKLOG` (days) | 30 | 45 | 75 | 120 |
| `OBJECTIONS_INCREASING` (net rise) | 1 | 3 | 6 | 12 |
| `LEGAL_ISSUE` (open cases) | 1 | 2 | 4 | 7 |
| `DOCUMENT_VERIFICATION_BACKLOG` (documents) | 3 | 8 | 15 | 25 |
| `DEPARTMENT_WORKLOAD_OVERLOAD` (index) | 0.75 | 0.85 | 0.95 | 1.10 |

`CRITICAL_RISK_LEVEL` has no ladder; it fires only on a governed CRITICAL
classification.

### Overrides

| Override | Effect |
|---|---|
| `STAY_ORDER_HARD_STOP` | A confirmed stay order is CRITICAL regardless of case counts |
| `DEGRADED_PREDICTION_CAP` | Model-derived detectors are capped at WARNING when the prediction is stale, rule-only, or LOW confidence |
| `NO_AGEING_DATA` | Compensation raises WARNING, labelled, when approval is open but no payment ageing is recorded |
| `DISPUTE_FLAG_ONLY` | A legal dispute flag with no case count raises WARNING, labelled |

The cap matters: a failing model must not page an officer at CRITICAL on the
strength of its own degraded output. The cap applies only to the four
model-derived detectors, so a stay order still reaches CRITICAL when the model is
down.

## 4. Avoiding alert fatigue

Six controls, applied in order.

**One live alert per project and type.** The `alerts` table is unique on
`(project_id, type)`, so a condition cannot accumulate duplicate rows.

**A quantized condition hash.** Each detector returns a coarse `stateBucket`,
normally its severity band plus the entity it concerns, such as the milestone id
or the department name. The hash of that bucket is stored. When a later run
produces the same hash, the condition is unchanged: the alert is updated in place
with a fresh measured value and an incremented occurrence count, and nothing is
notified. Quantizing is what makes this work, since a raw value such as overdue
days moves every single day without the situation actually changing.

**A per-severity cooldown**, in hours: INFO 168, WARNING 72, HIGH 24, CRITICAL 6.
A cooldown starts only when a run actually notifies. An escalation always breaks
it, because suppressing a CRITICAL on the grounds that a WARNING paged an hour
earlier is the failure that makes such a system unsafe rather than merely noisy.

**Correlation groups.** Within a group the strongest severity wins and the rest
are suppressed with reason `CORRELATED_ALERT`; a stored alert for a superseded
detector is resolved. `CRITICAL_RISK_LEVEL` supersedes `HIGH_DELAY_PROBABILITY`
in the `RISK_LEVEL` group, and trend and jump share `RISK_MOVEMENT`.

**A per-run notification budget** of three, which throttles only severities below
HIGH. Throttling a HIGH or CRITICAL to keep a queue tidy would defeat the system,
so those are exempt. Budgeted alerts stay live in the notification centre; only
the push is withheld. INFO never pushes at all.

**Dismissals hold.** A dismissed alert is not re-raised while the condition is
unchanged, because an official has already judged it. A severity escalation does
re-raise it, since that is a different condition from the one they judged.

### What each run decides

| Decision | Meaning | Notifies |
|---|---|---|
| `CREATED` | First crossing for this detector on this project | yes, subject to cooldown and budget |
| `ESCALATED` | Severity rose | yes, breaking any cooldown |
| `DE_ESCALATED` | Severity fell | no; the alert is updated silently |
| `UNCHANGED` | Same severity, same condition hash | never |
| `REOPENED` | Condition returned, or changed within its band | yes, subject to cooldown |
| `RESOLVED` | No threshold is crossed any more | no |

An escalation or a re-raise moves an acknowledged alert back to `OPEN`, because
the condition the officer acknowledged is no longer the condition on record.

Every detector appears in each run's output as an alert, a resolution, or a
suppression with a reason. Nothing is dropped silently.

## 5. Worked example

A project with six genuine conditions, evaluated three times.

**Run 1**, first evaluation. Nine alerts raised, nine notified.

```text
HIGH     COMPENSATION_BACKLOG            notify=true   CREATED
HIGH     DEPARTMENT_WORKLOAD_OVERLOAD    notify=true   CREATED
HIGH     DOCUMENT_VERIFICATION_BACKLOG   notify=true   CREATED
HIGH     MILESTONE_OVERDUE               notify=true   CREATED
HIGH     OBJECTIONS_INCREASING           notify=true   CREATED
HIGH     RISK_TREND_INCREASING           notify=true   CREATED
WARNING  HIGH_DELAY_PROBABILITY          notify=true   CREATED
WARNING  LEGAL_ISSUE                     notify=true   CREATED
WARNING  MILESTONE_DEADLINE_APPROACHING  notify=true   CREATED

suppressed:
  CRITICAL_RISK_LEVEL   NO_CONDITION
  RISK_SCORE_JUMP       CORRELATED_ALERT
```

**Run 2**, the next day, with overdue days moved from 26 to 30 and everything
else the same. Nine alerts remain live, **zero** notifications.

```text
HIGH     MILESTONE_OVERDUE   notify=false  UNCHANGED   (observed 2x)
...all nine UNCHANGED, notifications pushed: 0
```

**Run 3**, overdue days reach 50, crossing the CRITICAL rung.

```text
CRITICAL MILESTONE_OVERDUE   ESCALATED | Escalation breaks the active cooldown, so the alert notifies.
```

One alert notifies. The other eight stay silent.

A single alert carries everything an officer needs:

```text
Project:            Ring Road Phase II (NH-2026-014)
Alert type:         COMPENSATION_BACKLOG
Severity:           HIGH
Trigger:            payment_processing_days = 80 >= 75 (HIGH rung)
Timestamp:          2026-09-15T09:00:00.000Z
Description:        Compensation has been in processing for 80 day(s), at or
                    beyond the 75-day threshold.
Recommended action: Escalate the ageing compensation cases to the departmental
                    payment review and confirm a disbursement date.
Responsible:        Finance and Compensation Department
Acknowledgement:    OPEN, observed 1x
```

Nine alerts on a first evaluation is the intended behaviour, not a bug: the
budget bounds only the low-severity tail, and a project with six real HIGH
conditions is meant to surface six. The controls bite from the second run on.

## 6. API

```http
GET    /api/v1/notifications                   Notification centre, grouped by severity
GET    /api/v1/alerts                          Filter by status, severity, type, project, assignee
GET    /api/v1/alerts/activity                 Recent history across all projects
GET    /api/v1/alerts/{id}/history             Immutable history for one alert
POST   /api/v1/alerts/{id}/acknowledge         Record an acknowledgement, with a note
PATCH  /api/v1/alerts/{id}/status              In progress, resolved, or dismissed
POST   /api/v1/projects/{id}/alerts/evaluate   Run every detector for one project
POST   /api/v1/alerts/evaluate                 Sweep every active project
GET    /api/v1/alerts/policy-versions          Active policy and detector versions
```

The per-project evaluate body accepts an optional `snapshot` carrying `metrics`,
`departmentWorkload`, `predictionHistory`, and `observationHistory`, which take
precedence over values derived from the operational tables. `persist: false` and
`notify: false` allow a dry run.

The sweep is the scheduled entry point. It isolates failures per project, so one
bad record cannot stop the sweep for everything else, and reports the failures in
its response.

### Derived inputs

- **Prediction history** comes from the stored `predictions` rows.
- **Observation history** is read back from the feature snapshot stored with each
  prediction. Objection, compensation, and legal counts are not columns in the
  operational schema, so the "increasing" detectors only fire when a snapshot
  recorded them. Where nothing was recorded, the detector reports no condition
  rather than guessing a baseline.
- **Department workload** is open items against an assumed capacity of six per
  active project, shared with the recommendation engine.
- **Responsible officers** are matched from the user directory: a department
  officer in the project's district first, then any officer for the department,
  then a district officer, then a state administrator. The match rule used is
  recorded on the alert, and an alert with no officer routes to the department
  with a limitation saying so.

## 7. Persistence and history

`alerts` holds one row per project and detector type, with the trigger
expression, recommended action, responsible department and officer, evidence,
condition hash, occurrence count, cooldown, and the policy and detector versions
that produced it.

`alert_events` is an immutable history. Rows are never updated. It records
`RAISED`, `OBSERVED`, `ESCALATED`, `DE_ESCALATED`, `ACKNOWLEDGED`,
`IN_PROGRESS`, `RESOLVED`, `DISMISSED`, and `REOPENED`, each with severity and
status before and after, the reason, the measured evidence, and the actor.

An `OBSERVED` row is written only when the measured value moved by at least the
detector's material delta. Without that rule a daily sweep would append a history
row per detector per project per day and the history would be unreadable.

Schema changes, all requiring a migration:

- `alerts`: `priority` becomes a typed `severity` enum; adds `trigger`,
  `recommended_action`, `responsible_department`, `responsibility_basis`,
  `evidence`, `condition_hash`, `occurrence_count`, `first_triggered_at`,
  `last_observed_at`, `cooldown_until`, `last_notified_at`, `policy_version`,
  `detector_version`, `model_version`, `prediction_id`, `acknowledged_by_id`,
  `acknowledgement_note`, `resolution_reason`, `updated_at`, and a unique index
  on `(project_id, type)`.
- `alert_events`: new table.
- `users`: adds `department`, so an alert can name a person rather than only a
  department.

Run `npm run prisma:migrate` before deploying.

## 8. Notification centre

`GET /api/v1/notifications` returns live alerts grouped by severity with the
counts a badge needs, oldest unacknowledged first inside each group so a new
arrival does not push an ageing item out of view. `?mine=true` scopes to the
caller's assigned alerts, and `?district=` scopes to a district.

The frontend renders it at `/alerts` with severity filters and per-alert
acknowledgement, and the sidebar badge and bell indicator read the same counts.
When the API is unreachable the page falls back to a demo feed derived from the
project registry rows on screen, labelled as such.

## 9. Governance

- An alert is a threshold crossing on recorded data, not a causal finding. Every
  description and recommended action passes the same controlled-language guard
  the recommendation engine uses, which rejects causal verbs and certainty
  claims.
- Every alert carries limitations, including when no officer is mapped, when the
  prediction is degraded, and when the data origin is `SYNTHETIC_DEMO`.
- Officer decisions are retained. Acknowledgements and dismissals are never
  overwritten by a sweep, only by an escalation of the underlying condition.
- Changing a threshold, ladder, cooldown, or budget is a change to `policy.ts`
  and should ship with a new `ALERT_POLICY_VERSION`, because stored alerts
  reference it.

## 10. Tests

`backend/test/alertEngine.test.ts` covers all eleven detectors and their ladders,
the required fields on every alert, dedup on an unchanged condition, condition
hash stability, escalation breaking a cooldown, silent de-escalation, cooldown
holds, dismissal behaviour on both an unchanged and an escalating condition,
auto-resolution, both correlation groups, the INFO notification floor, the budget
exempting HIGH and CRITICAL, the degraded-prediction cap and its exemption for
hard stops, determinism, and the controlled-language guard.

```bash
cd backend && npm test
```
