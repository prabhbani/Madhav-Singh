# Synthetic Land Acquisition Dataset

File: `synthetic_land_acquisition_cases.csv`

This is a **SYNTHETIC** demonstration and model-development dataset. It does not
contain official government data and must not be presented as government statistics.
It contains 6,000 case-level records generated with seed `20260915`. The generator
can reproduce the same file:

```bash
python3 data/generate_synthetic_dataset.py --rows 6000 --seed 20260915 \
  --output data/synthetic_land_acquisition_cases.csv
```

## Generation methodology

Each row represents a point-in-time case snapshot. Predictors are generated first;
labels are generated afterwards from a noisy latent risk process. No completion
date, final outcome, or latent target probability is exported as an input feature.

The simulator creates relationships in this order:

1. Select a state, district, region, urban/rural class, and department.
2. Select project type, priority, land use, and acquisition method.
3. Generate project area, parcel count, and affected landowners with correlated
   log-normal and count distributions.
4. Derive ownership complexity, disputed ownership, and unresolved records.
5. Generate objections from landowner count, ownership complexity, and land use.
6. Generate document requirements, missing documents, invalid documents, and
   verification backlog from complexity and department workload.
7. Generate approval queues and blocked dependencies from project type and workload.
8. Generate legal disputes, hearings, and stay orders from objections and ownership
   conditions, with random noise.
9. Generate compensation exposure, approval, pending amount, and payment processing
   time from area, land use, workload, and legal status.
10. Generate stage duration, stage age, overdue days, and milestone slippage from
    the accumulated workflow conditions.
11. Generate noisy delay probability, sample the delay outcome, and generate delay
    duration with separate noise so prediction is not perfectly deterministic.
12. Derive the demonstration risk category from probability bands plus explicit
    hard-stop conditions.

This is a plausible simulation of workflow relationships, not a calibrated estimate
of any state's or department's real performance.

## Data dictionary

### Provenance and identifiers

| Field | Type | Role | Notes |
|---|---|---|---|
| `data_origin` | Categorical | Governance | Always `SYNTHETIC` |
| `synthetic_scenario` | Categorical | Governance | Generation scenario label |
| `case_id` | String | Identifier | Synthetic case identifier; exclude from ML |
| `project_id` | String | Grouping identifier | Cases share projects; use for group splits, exclude as feature |
| `as_of_date` | Date | Temporal feature | Prediction snapshot date |
| `prediction_horizon_days` | Integer | Configuration | Fixed at 90 in this dataset |

### Geography and administration

| Field | Type | Role | Notes |
|---|---|---|---|
| `state` | Categorical | Feature | Synthetic jurisdiction |
| `district` | Categorical | Feature | Synthetic district |
| `region` | Categorical | Feature | Coarse region |
| `urban_rural` | Categorical | Feature | Synthetic locality class |
| `department` | Categorical | Feature | Owning department |
| `project_type` | Categorical | Feature | Road, rail, irrigation, and similar types |
| `acquisition_method` | Categorical | Feature | Workflow method |
| `project_priority` | Ordered categorical | Feature | Low, medium, high, critical |
| `land_use_category` | Categorical | Feature | Land-use classification |
| `department_workload_index` | Numeric `[0,1]` | Feature | Synthetic workload pressure |
| `historical_department_delay_rate` | Numeric `[0,1]` | Feature | Prior-history proxy generated before outcome |
| `historical_district_delay_rate` | Numeric `[0,1]` | Feature | Prior-history proxy generated before outcome |

### Project, parcel, and ownership features

| Field | Type | Role | Notes |
|---|---|---|---|
| `project_size_area` | Numeric | Feature | Synthetic area; positively related to parcel count |
| `parcel_count` | Integer | Feature | Number of parcels |
| `affected_landowner_count` | Integer | Feature | Positively related to objections |
| `ownership_complexity_score` | Numeric `[0,1]` | Feature | Joint ownership and records complexity |
| `disputed_ownership_flag` | Boolean integer | Feature | `0` or `1` |
| `unresolved_record_count` | Integer | Feature | Unresolved ownership/record items |
| `acquisition_complexity_score` | Numeric `[0,1]` | Feature | Composite operational complexity; formula is versioned in generator |

### Objection, document, and approval features

| Field | Type | Role | Notes |
|---|---|---|---|
| `objection_count` | Integer | Feature | Total objections known at snapshot |
| `unresolved_objection_count` | Integer | Feature | Open objections |
| `required_document_count` | Integer | Feature | Required evidence count |
| `missing_document_count` | Integer | Feature | Missing evidence |
| `invalid_document_count` | Integer | Feature | Rejected or invalid evidence |
| `document_verification_pending_count` | Integer | Feature | Verification backlog |
| `document_completeness_ratio` | Numeric `[0,1]` | Feature | Snapshot completeness |
| `approval_stage_count` | Integer | Feature | Number of approval stages |
| `pending_approval_count` | Integer | Feature | Approvals not complete |
| `interdepartment_dependency_count` | Integer | Feature | External coordination dependencies |
| `blocked_dependency_count` | Integer | Feature | Dependencies currently blocked |

### Compensation and legal features

| Field | Type | Role | Notes |
|---|---|---|---|
| `assessed_compensation_amount` | Numeric INR-like demo amount | Feature | Assessment exposure; not official currency data |
| `approved_compensation_amount` | Numeric | Feature | Amount approved at snapshot |
| `pending_compensation_amount` | Numeric | Feature | Amount still pending |
| `compensation_approval_pending_flag` | Boolean integer | Feature | `1` when approval is pending |
| `payment_processing_days` | Integer | Feature | Historical/current processing estimate |
| `open_legal_case_count` | Integer | Feature | Open legal matters |
| `legal_dispute_flag` | Boolean integer | Feature | Any open legal dispute |
| `stay_order_flag` | Boolean integer | Feature | Active stay order indicator |
| `hearing_count` | Integer | Feature | Hearings known at snapshot |

### Temporal and workflow features

| Field | Type | Role | Notes |
|---|---|---|---|
| `current_stage` | Categorical | Feature | Current workflow stage |
| `days_in_current_stage` | Integer | Feature | Stage age at snapshot |
| `overdue_days` | Integer | Feature | Schedule slippage at snapshot |
| `average_stage_duration_days` | Integer | Feature | Historical/current stage duration estimate |
| `milestone_slippage_count` | Integer | Feature | Prior missed or rescheduled milestones |
| `days_since_last_update` | Integer | Feature | Staleness of case activity |
| `missing_optional_payment_history` | Nullable integer | Feature | Demonstrates realistic incomplete data |
| `missing_optional_hearing_history` | Nullable integer | Feature | Demonstrates realistic incomplete data |

### Targets and leakage controls

| Field | Type | Role | ML use |
|---|---|---|---|
| `significant_delay` | Binary | Target 1 | Label only; never input |
| `actual_delay_days` | Numeric | Target 2 | Label only; never input |
| `risk_category` | Categorical | Target 3 | Label only; never input |

The target fields are intentionally in the same CSV for supervised model
development. A production feature builder must remove them before inference.

## Target generation logic

The delay label is generated from a latent risk score containing capped nonlinear
effects from size, ownership, objections, documents, approvals, dependencies,
workload, legal status, schedule slippage, geography, and historical processing
rates. A Gaussian noise term is added before applying a sigmoid probability. The
binary label is sampled from that probability; it is not a deterministic threshold.

For delayed cases, `actual_delay_days` is sampled from a noisy gamma-like duration
process and adjusted by overdue days and stay orders. Non-delayed cases can still
have small slippage. This prevents the duration target from perfectly revealing
the binary target.

Risk categories use starting policy bands and hard-stop conditions:

```text
CRITICAL: probability >= 0.78 or confirmed stay/high-risk legal override
HIGH:     probability >= 0.55
MEDIUM:   probability >= 0.30
LOW:      otherwise
```

These labels are synthetic policy outputs, not official risk standards.

## Data quality checks

Run:

```bash
python3 data/validate_synthetic_dataset.py \
  data/synthetic_land_acquisition_cases.csv
```

The validator checks:

- At least 5,000 rows.
- Unique case identifiers.
- Exactly `SYNTHETIC` provenance.
- Required columns and no exported latent target probability.
- Valid target values and risk categories.
- Non-negative counts, durations, areas, and monetary amounts.
- Ratios and scores within `[0,1]`.
- Correlated relationships with minimum sanity thresholds.
- Missing values only in designated optional-history fields.
- No missing identifiers or target labels.

The generator is intentionally noisy. Correlations are expected to be positive,
not perfect. The observed relationship report should be reviewed after every seed
or formula change.

## Missing-value strategy

Missing optional payment and hearing history values represent incomplete source
systems. Keep the missingness indicator during preprocessing. Do not silently
convert missing to zero because “no record” is not always “no event”. For model
training, fit imputers on the training partition only and add explicit missing
flags. In production, expose missingness and data freshness in prediction metadata.

## Outlier strategy

The generator uses log-normal area and compensation distributions, capped nonlinear
feature contributions, and count bounds in the target function. It does not delete
large cases because they are plausible operational cases. For modeling:

- Inspect extreme values by project type and district.
- Apply `log1p` to skewed counts and monetary amounts.
- Use robust scaling for linear models.
- Use winsorization only when a value is demonstrably erroneous, not merely large.
- Keep an outlier flag so officials can see when a case is outside common support.
- Evaluate models with and without extreme cases.

## Leakage warning

Do not use `actual_delay_days`, `significant_delay`, or `risk_category` as predictors.
Do not add completion dates, final payment status, resolved objection counts, final
stage durations, or post-prediction intervention outcomes to the feature set. This
CSV is a supervised development artifact; production inference must build features
from the point-in-time snapshot only.