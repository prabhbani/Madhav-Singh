-- Predictive Analytics System for Early Detection of Land Acquisition Delays
-- PostgreSQL 15+. Operational schema; analytical projections are at the end.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TYPE data_origin AS ENUM ('REAL', 'SYNTHETIC_DEMO', 'USER_ENTERED', 'IMPORTED');
CREATE TYPE record_status AS ENUM ('ACTIVE', 'INACTIVE', 'ARCHIVED');
CREATE TYPE case_status AS ENUM ('DRAFT', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED');
CREATE TYPE stage_status AS ENUM ('NOT_STARTED', 'ACTIVE', 'COMPLETED', 'SKIPPED', 'BLOCKED');
CREATE TYPE milestone_status AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'OVERDUE', 'CANCELLED');
CREATE TYPE document_status AS ENUM ('REQUIRED', 'SUBMITTED', 'VERIFIED', 'REJECTED', 'EXPIRED');
CREATE TYPE notice_type AS ENUM ('PRELIMINARY', 'DECLARATION', 'AWARD', 'PAYMENT', 'HEARING', 'OTHER');
CREATE TYPE notice_status AS ENUM ('DRAFT', 'ISSUED', 'SERVED', 'ACKNOWLEDGED', 'RETURNED', 'CANCELLED');
CREATE TYPE hearing_status AS ENUM ('SCHEDULED', 'HELD', 'ADJOURNED', 'CANCELLED');
CREATE TYPE objection_status AS ENUM ('RECEIVED', 'UNDER_REVIEW', 'RESOLVED', 'WITHDRAWN', 'REJECTED');
CREATE TYPE legal_status AS ENUM ('OPEN', 'STAYED', 'DISPOSED', 'WITHDRAWN');
CREATE TYPE risk_level AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
CREATE TYPE alert_status AS ENUM ('OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLVED', 'DISMISSED');
CREATE TYPE priority_level AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
CREATE TYPE event_type AS ENUM ('CASE_CREATED', 'STAGE_STARTED', 'STAGE_COMPLETED', 'MILESTONE_UPDATED', 'DOCUMENT_UPDATED', 'NOTICE_ISSUED', 'HEARING_HELD', 'OBJECTION_UPDATED', 'LEGAL_UPDATED', 'COMPENSATION_UPDATED', 'RISK_UPDATED', 'ALERT_CREATED', 'INTERVENTION_RECORDED', 'OTHER');

CREATE TABLE states (
    state_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code varchar(10) NOT NULL UNIQUE,
    name varchar(120) NOT NULL UNIQUE,
    status record_status NOT NULL DEFAULT 'ACTIVE',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE districts (
    district_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    state_id uuid NOT NULL REFERENCES states(state_id),
    code varchar(20) NOT NULL,
    name varchar(120) NOT NULL,
    status record_status NOT NULL DEFAULT 'ACTIVE',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (state_id, code),
    UNIQUE (state_id, name)
);

CREATE TABLE departments (
    department_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code varchar(40) NOT NULL UNIQUE,
    name varchar(180) NOT NULL UNIQUE,
    parent_department_id uuid REFERENCES departments(department_id),
    status record_status NOT NULL DEFAULT 'ACTIVE',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (parent_department_id IS NULL OR parent_department_id <> department_id)
);

CREATE TABLE officers (
    officer_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    department_id uuid NOT NULL REFERENCES departments(department_id),
    district_id uuid REFERENCES districts(district_id),
    employee_code varchar(80) NOT NULL UNIQUE,
    display_name varchar(180) NOT NULL,
    designation varchar(160),
    email varchar(254),
    phone varchar(40),
    status record_status NOT NULL DEFAULT 'ACTIVE',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE land_acquisition_projects (
    project_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    state_id uuid NOT NULL REFERENCES states(state_id),
    district_id uuid NOT NULL REFERENCES districts(district_id),
    owning_department_id uuid NOT NULL REFERENCES departments(department_id),
    project_code varchar(80) NOT NULL UNIQUE,
    name varchar(240) NOT NULL,
    project_type varchar(100) NOT NULL,
    acquisition_method varchar(100),
    priority priority_level NOT NULL DEFAULT 'MEDIUM',
    planned_start_date date NOT NULL,
    approved_target_date date NOT NULL,
    total_area_required numeric(18,4),
    total_parcel_count integer,
    status case_status NOT NULL DEFAULT 'DRAFT',
    data_origin data_origin NOT NULL DEFAULT 'USER_ENTERED',
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (approved_target_date >= planned_start_date),
    CHECK (total_area_required IS NULL OR total_area_required >= 0),
    CHECK (total_parcel_count IS NULL OR total_parcel_count >= 0)
);

CREATE TABLE acquisition_cases (
    case_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES land_acquisition_projects(project_id),
    district_id uuid NOT NULL REFERENCES districts(district_id),
    current_department_id uuid REFERENCES departments(department_id),
    current_officer_id uuid REFERENCES officers(officer_id),
    case_number varchar(100) NOT NULL UNIQUE,
    status case_status NOT NULL DEFAULT 'DRAFT',
    opened_on date NOT NULL,
    closed_on date,
    data_origin data_origin NOT NULL DEFAULT 'USER_ENTERED',
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (closed_on IS NULL OR closed_on >= opened_on),
    CHECK ((status IN ('COMPLETED', 'CANCELLED') AND closed_on IS NOT NULL) OR status NOT IN ('COMPLETED', 'CANCELLED'))
);

CREATE TABLE parcels (
    parcel_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    district_id uuid NOT NULL REFERENCES districts(district_id),
    survey_number varchar(120) NOT NULL,
    village varchar(160),
    land_use_category varchar(100),
    area_required numeric(18,4) NOT NULL,
    area_unit varchar(20) NOT NULL DEFAULT 'HECTARE',
    ownership_type varchar(100),
    title_verified boolean NOT NULL DEFAULT false,
    mutation_status varchar(80),
    encumbrance_status varchar(80),
    geometry geography(Geometry, 4326),
    data_origin data_origin NOT NULL DEFAULT 'USER_ENTERED',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (district_id, survey_number),
    CHECK (area_required > 0)
);

CREATE TABLE case_parcels (
    case_id uuid NOT NULL REFERENCES acquisition_cases(case_id) ON DELETE CASCADE,
    parcel_id uuid NOT NULL REFERENCES parcels(parcel_id),
    resolution_status varchar(40) NOT NULL DEFAULT 'UNRESOLVED',
    resolved_at timestamptz,
    PRIMARY KEY (case_id, parcel_id),
    CHECK ((resolution_status = 'RESOLVED' AND resolved_at IS NOT NULL) OR resolution_status <> 'RESOLVED')
);

CREATE TABLE landowners (
    landowner_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    district_id uuid REFERENCES districts(district_id),
    party_reference varchar(100) NOT NULL UNIQUE,
    display_name varchar(240) NOT NULL,
    owner_type varchar(60),
    contact_details jsonb NOT NULL DEFAULT '{}'::jsonb,
    vulnerable_group_flag boolean NOT NULL DEFAULT false,
    data_origin data_origin NOT NULL DEFAULT 'USER_ENTERED',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE case_landowners (
    case_id uuid NOT NULL REFERENCES acquisition_cases(case_id) ON DELETE CASCADE,
    landowner_id uuid NOT NULL REFERENCES landowners(landowner_id),
    role varchar(60) NOT NULL DEFAULT 'OWNER',
    affected_area numeric(18,4),
    relationship_start timestamptz NOT NULL DEFAULT now(),
    relationship_end timestamptz,
    PRIMARY KEY (case_id, landowner_id),
    CHECK (affected_area IS NULL OR affected_area >= 0),
    CHECK (relationship_end IS NULL OR relationship_end > relationship_start)
);

CREATE TABLE acquisition_stages (
    stage_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code varchar(80) NOT NULL UNIQUE,
    name varchar(160) NOT NULL UNIQUE,
    sequence_no integer NOT NULL UNIQUE,
    default_duration_days integer,
    status record_status NOT NULL DEFAULT 'ACTIVE',
    CHECK (sequence_no > 0),
    CHECK (default_duration_days IS NULL OR default_duration_days >= 0)
);

CREATE TABLE case_stages (
    case_stage_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id uuid NOT NULL REFERENCES acquisition_cases(case_id) ON DELETE CASCADE,
    stage_id uuid NOT NULL REFERENCES acquisition_stages(stage_id),
    owning_department_id uuid REFERENCES departments(department_id),
    assigned_officer_id uuid REFERENCES officers(officer_id),
    status stage_status NOT NULL DEFAULT 'NOT_STARTED',
    planned_start_at timestamptz,
    planned_end_at timestamptz,
    actual_start_at timestamptz,
    actual_end_at timestamptz,
    blocked_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (case_id, stage_id),
    CHECK (planned_end_at IS NULL OR planned_start_at IS NULL OR planned_end_at >= planned_start_at),
    CHECK (actual_end_at IS NULL OR actual_start_at IS NULL OR actual_end_at >= actual_start_at),
    CHECK (status <> 'COMPLETED' OR actual_end_at IS NOT NULL),
    CHECK (status <> 'BLOCKED' OR blocked_reason IS NOT NULL)
);

CREATE TABLE milestones (
    milestone_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id uuid NOT NULL REFERENCES acquisition_cases(case_id) ON DELETE CASCADE,
    case_stage_id uuid REFERENCES case_stages(case_stage_id),
    owning_department_id uuid REFERENCES departments(department_id),
    assigned_officer_id uuid REFERENCES officers(officer_id),
    name varchar(200) NOT NULL,
    milestone_type varchar(80),
    status milestone_status NOT NULL DEFAULT 'PENDING',
    planned_at timestamptz NOT NULL,
    actual_at timestamptz,
    overdue_since timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (actual_at IS NULL OR actual_at >= planned_at),
    CHECK (status <> 'COMPLETED' OR actual_at IS NOT NULL),
    CHECK (status <> 'OVERDUE' OR overdue_since IS NOT NULL)
);

ALTER TABLE acquisition_cases
    ADD COLUMN current_case_stage_id uuid REFERENCES case_stages(case_stage_id);

CREATE TABLE documents (
    document_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id uuid NOT NULL REFERENCES acquisition_cases(case_id) ON DELETE CASCADE,
    parcel_id uuid REFERENCES parcels(parcel_id),
    landowner_id uuid REFERENCES landowners(landowner_id),
    document_type varchar(120) NOT NULL,
    status document_status NOT NULL DEFAULT 'REQUIRED',
    document_reference varchar(160),
    submitted_at timestamptz,
    verified_at timestamptz,
    expires_at timestamptz,
    storage_key varchar(500),
    checksum_sha256 char(64),
    data_origin data_origin NOT NULL DEFAULT 'USER_ENTERED',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (verified_at IS NULL OR submitted_at IS NOT NULL),
    CHECK (status <> 'VERIFIED' OR verified_at IS NOT NULL),
    CHECK (expires_at IS NULL OR submitted_at IS NULL OR expires_at >= submitted_at)
);

CREATE TABLE notices (
    notice_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id uuid NOT NULL REFERENCES acquisition_cases(case_id) ON DELETE CASCADE,
    landowner_id uuid REFERENCES landowners(landowner_id),
    notice_type notice_type NOT NULL,
    notice_number varchar(120) NOT NULL UNIQUE,
    status notice_status NOT NULL DEFAULT 'DRAFT',
    issued_at timestamptz,
    served_at timestamptz,
    acknowledged_at timestamptz,
    response_due_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (served_at IS NULL OR issued_at IS NOT NULL),
    CHECK (acknowledged_at IS NULL OR served_at IS NOT NULL),
    CHECK (response_due_at IS NULL OR issued_at IS NULL OR response_due_at >= issued_at)
);

CREATE TABLE hearings (
    hearing_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id uuid NOT NULL REFERENCES acquisition_cases(case_id) ON DELETE CASCADE,
    notice_id uuid REFERENCES notices(notice_id),
    scheduled_at timestamptz NOT NULL,
    held_at timestamptz,
    status hearing_status NOT NULL DEFAULT 'SCHEDULED',
    venue varchar(240),
    outcome text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (held_at IS NULL OR held_at >= scheduled_at),
    CHECK (status <> 'HELD' OR held_at IS NOT NULL)
);

CREATE TABLE compensation_assessments (
    assessment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id uuid NOT NULL REFERENCES acquisition_cases(case_id) ON DELETE CASCADE,
    parcel_id uuid REFERENCES parcels(parcel_id),
    landowner_id uuid REFERENCES landowners(landowner_id),
    assessed_amount numeric(18,2) NOT NULL,
    approved_amount numeric(18,2),
    currency_code char(3) NOT NULL DEFAULT 'INR',
    assessed_at timestamptz NOT NULL,
    approved_at timestamptz,
    status varchar(40) NOT NULL DEFAULT 'PENDING',
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (assessed_amount >= 0),
    CHECK (approved_amount IS NULL OR approved_amount >= 0),
    CHECK (approved_at IS NULL OR approved_at >= assessed_at)
);

CREATE TABLE compensation_payments (
    payment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    assessment_id uuid NOT NULL REFERENCES compensation_assessments(assessment_id) ON DELETE CASCADE,
    payment_reference varchar(140) UNIQUE,
    amount numeric(18,2) NOT NULL,
    scheduled_at timestamptz,
    paid_at timestamptz,
    status varchar(40) NOT NULL DEFAULT 'PENDING',
    failure_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (amount > 0),
    CHECK (paid_at IS NULL OR scheduled_at IS NULL OR paid_at >= scheduled_at),
    CHECK (status <> 'FAILED' OR failure_reason IS NOT NULL)
);

CREATE TABLE objections (
    objection_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id uuid NOT NULL REFERENCES acquisition_cases(case_id) ON DELETE CASCADE,
    landowner_id uuid REFERENCES landowners(landowner_id),
    notice_id uuid REFERENCES notices(notice_id),
    received_at timestamptz NOT NULL,
    category varchar(100),
    description text,
    status objection_status NOT NULL DEFAULT 'RECEIVED',
    resolved_at timestamptz,
    resolution text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (resolved_at IS NULL OR resolved_at >= received_at),
    CHECK (status NOT IN ('RESOLVED', 'WITHDRAWN', 'REJECTED') OR resolved_at IS NOT NULL)
);

CREATE TABLE legal_cases (
    legal_case_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id uuid NOT NULL REFERENCES acquisition_cases(case_id) ON DELETE CASCADE,
    parcel_id uuid REFERENCES parcels(parcel_id),
    landowner_id uuid REFERENCES landowners(landowner_id),
    case_number varchar(160) NOT NULL UNIQUE,
    court_name varchar(240),
    matter_type varchar(100),
    status legal_status NOT NULL DEFAULT 'OPEN',
    filed_at timestamptz NOT NULL,
    disposed_at timestamptz,
    stay_order_flag boolean NOT NULL DEFAULT false,
    next_hearing_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (disposed_at IS NULL OR disposed_at >= filed_at),
    CHECK (status <> 'DISPOSED' OR disposed_at IS NOT NULL)
);

CREATE TABLE model_versions (
    model_version varchar(120) PRIMARY KEY,
    model_name varchar(160) NOT NULL,
    model_family varchar(80) NOT NULL,
    deployment_status varchar(20) NOT NULL DEFAULT 'CANDIDATE'
        CHECK (deployment_status IN ('CANDIDATE', 'SHADOW', 'CHAMPION', 'RETIRED', 'REJECTED')),
    feature_version varchar(80) NOT NULL,
    label_policy_version varchar(80) NOT NULL,
    calibration_method varchar(80),
    calibration_version varchar(120),
    artifact_uri varchar(500) NOT NULL,
    artifact_sha256 char(64) NOT NULL,
    training_started_at timestamptz,
    training_ended_at timestamptz,
    metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
    subgroup_metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
    predecessor_version varchar(120) REFERENCES model_versions(model_version),
    approved_by uuid REFERENCES officers(officer_id),
    approved_at timestamptz,
    retired_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (training_ended_at IS NULL OR training_started_at IS NULL OR training_ended_at >= training_started_at),
    CHECK (approved_at IS NULL OR deployment_status IN ('SHADOW', 'CHAMPION', 'RETIRED')),
    CHECK (retired_at IS NULL OR deployment_status = 'RETIRED')
);

CREATE TABLE risk_policies (
    policy_version varchar(80) PRIMARY KEY,
    name varchar(160) NOT NULL,
    status varchar(20) NOT NULL DEFAULT 'DRAFT'
        CHECK (status IN ('DRAFT', 'ACTIVE', 'RETIRED')),
    probability_thresholds jsonb NOT NULL,
    hard_overrides jsonb NOT NULL DEFAULT '[]'::jsonb,
    rule_configuration jsonb NOT NULL,
    effective_from timestamptz NOT NULL,
    effective_to timestamptz,
    approved_by uuid REFERENCES officers(officer_id),
    approved_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (effective_to IS NULL OR effective_to > effective_from),
    CHECK (status <> 'ACTIVE' OR approved_at IS NOT NULL)
);

CREATE TABLE risk_assessments (
    risk_assessment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id uuid NOT NULL REFERENCES acquisition_cases(case_id) ON DELETE CASCADE,
    assessment_at timestamptz NOT NULL DEFAULT now(),
    ml_probability numeric(6,5),
    rule_score numeric(6,5),
    final_level risk_level NOT NULL,
    score_reason text,
    source varchar(30) NOT NULL CHECK (source IN ('ML', 'RULE', 'COMBINED', 'MANUAL')),
    model_version varchar(120),
    feature_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_by uuid REFERENCES officers(officer_id),
    CHECK (ml_probability IS NULL OR ml_probability BETWEEN 0 AND 1),
    CHECK (rule_score IS NULL OR rule_score BETWEEN 0 AND 1)
);

CREATE TABLE rule_evaluations (
    rule_evaluation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id uuid NOT NULL REFERENCES acquisition_cases(case_id) ON DELETE CASCADE,
    risk_assessment_id uuid REFERENCES risk_assessments(risk_assessment_id) ON DELETE CASCADE,
    policy_version varchar(80) NOT NULL REFERENCES risk_policies(policy_version),
    rule_code varchar(100) NOT NULL,
    evaluated_at timestamptz NOT NULL DEFAULT now(),
    triggered boolean NOT NULL,
    contribution numeric(6,5) NOT NULL,
    measured_value jsonb NOT NULL DEFAULT '{}'::jsonb,
    threshold_value jsonb NOT NULL DEFAULT '{}'::jsonb,
    evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
    recommended_action text,
    CHECK (contribution BETWEEN 0 AND 1)
);

CREATE TABLE predictions (
    prediction_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id uuid NOT NULL REFERENCES acquisition_cases(case_id) ON DELETE CASCADE,
    model_version varchar(120) NOT NULL,
    predicted_at timestamptz NOT NULL DEFAULT now(),
    horizon_days integer NOT NULL,
    delay_probability numeric(6,5) NOT NULL,
    expected_delay_days numeric(12,2),
    lower_delay_days numeric(12,2),
    upper_delay_days numeric(12,2),
    confidence_score numeric(6,5),
    confidence_band varchar(20) CHECK (confidence_band IN ('LOW', 'MEDIUM', 'HIGH')),
    input_snapshot jsonb NOT NULL,
    explanation jsonb NOT NULL DEFAULT '{}'::jsonb,
    CHECK (horizon_days > 0),
    CHECK (delay_probability BETWEEN 0 AND 1),
    CHECK (expected_delay_days IS NULL OR expected_delay_days >= 0),
    CHECK (lower_delay_days IS NULL OR lower_delay_days >= 0),
    CHECK (upper_delay_days IS NULL OR upper_delay_days >= 0),
    CHECK (confidence_score IS NULL OR confidence_score BETWEEN 0 AND 1),
    CHECK (lower_delay_days IS NULL OR upper_delay_days IS NULL OR upper_delay_days >= lower_delay_days)
);

CREATE TABLE prediction_explanations (
    explanation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    prediction_id uuid NOT NULL UNIQUE REFERENCES predictions(prediction_id) ON DELETE CASCADE,
    explanation_method varchar(80) NOT NULL,
    baseline_probability numeric(6,5),
    predicted_probability numeric(6,5),
    confidence_score numeric(6,5),
    confidence_band varchar(20) NOT NULL CHECK (confidence_band IN ('LOW', 'MEDIUM', 'HIGH')),
    limitations jsonb NOT NULL DEFAULT '[]'::jsonb,
    generated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (baseline_probability IS NULL OR baseline_probability BETWEEN 0 AND 1),
    CHECK (predicted_probability IS NULL OR predicted_probability BETWEEN 0 AND 1),
    CHECK (confidence_score IS NULL OR confidence_score BETWEEN 0 AND 1)
);

CREATE TABLE prediction_factors (
    factor_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    prediction_id uuid NOT NULL REFERENCES predictions(prediction_id) ON DELETE CASCADE,
    rule_evaluation_id uuid REFERENCES rule_evaluations(rule_evaluation_id),
    rank integer NOT NULL,
    factor_code varchar(120) NOT NULL,
    display_label varchar(240) NOT NULL,
    source varchar(30) NOT NULL CHECK (source IN ('ML', 'RULE', 'ML_AND_RULE')),
    direction varchar(30) NOT NULL CHECK (direction IN ('INCREASES_RISK', 'REDUCES_RISK', 'NEUTRAL')),
    signed_contribution numeric(12,8) NOT NULL,
    relative_contribution numeric(8,5),
    current_value jsonb NOT NULL DEFAULT '{}'::jsonb,
    comparison_value jsonb,
    explanation text NOT NULL,
    evidence_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (prediction_id, rank),
    CHECK (rank > 0),
    CHECK (relative_contribution IS NULL OR relative_contribution BETWEEN 0 AND 1)
);

CREATE TABLE model_feature_importance (
    model_version varchar(120) NOT NULL REFERENCES model_versions(model_version) ON DELETE CASCADE,
    feature_code varchar(120) NOT NULL,
    importance_method varchar(50) NOT NULL CHECK (importance_method IN ('MEAN_ABS_SHAP', 'PERMUTATION', 'GAIN', 'COEFFICIENT')),
    mean_abs_importance numeric(18,8) NOT NULL,
    mean_signed_importance numeric(18,8),
    rank integer NOT NULL,
    cohort jsonb NOT NULL DEFAULT '{}'::jsonb,
    generated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (model_version, feature_code, importance_method, cohort),
    CHECK (mean_abs_importance >= 0),
    CHECK (rank > 0)
);

CREATE TABLE alerts (
    alert_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id uuid NOT NULL REFERENCES acquisition_cases(case_id) ON DELETE CASCADE,
    milestone_id uuid REFERENCES milestones(milestone_id),
    alert_type varchar(100) NOT NULL,
    priority priority_level NOT NULL,
    status alert_status NOT NULL DEFAULT 'OPEN',
    triggered_at timestamptz NOT NULL DEFAULT now(),
    acknowledged_at timestamptz,
    resolved_at timestamptz,
    assigned_department_id uuid REFERENCES departments(department_id),
    assigned_officer_id uuid REFERENCES officers(officer_id),
    trigger_details jsonb NOT NULL DEFAULT '{}'::jsonb,
    CHECK (acknowledged_at IS NULL OR acknowledged_at >= triggered_at),
    CHECK (resolved_at IS NULL OR resolved_at >= triggered_at)
);

CREATE TABLE recommendations (
    recommendation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id uuid NOT NULL REFERENCES acquisition_cases(case_id) ON DELETE CASCADE,
    alert_id uuid REFERENCES alerts(alert_id),
    recommendation_type varchar(100) NOT NULL,
    title varchar(240) NOT NULL,
    rationale text NOT NULL,
    priority priority_level NOT NULL,
    target_department_id uuid REFERENCES departments(department_id),
    target_officer_id uuid REFERENCES officers(officer_id),
    status varchar(40) NOT NULL DEFAULT 'OPEN',
    due_at timestamptz,
    completed_at timestamptz,
    source varchar(20) NOT NULL CHECK (source IN ('RULE', 'ML_ASSISTED', 'MANUAL')),
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (completed_at IS NULL OR due_at IS NULL OR completed_at >= due_at)
);

CREATE TABLE prediction_recommendations (
    prediction_id uuid NOT NULL REFERENCES predictions(prediction_id) ON DELETE CASCADE,
    recommendation_id uuid NOT NULL REFERENCES recommendations(recommendation_id) ON DELETE CASCADE,
    rank integer NOT NULL,
    PRIMARY KEY (prediction_id, recommendation_id),
    UNIQUE (prediction_id, rank),
    CHECK (rank > 0)
);

CREATE TABLE historical_events (
    event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id uuid REFERENCES acquisition_cases(case_id) ON DELETE CASCADE,
    project_id uuid REFERENCES land_acquisition_projects(project_id) ON DELETE CASCADE,
    event_type event_type NOT NULL,
    occurred_at timestamptz NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT now(),
    actor_officer_id uuid REFERENCES officers(officer_id),
    department_id uuid REFERENCES departments(department_id),
    entity_type varchar(80) NOT NULL,
    entity_id uuid,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    data_origin data_origin NOT NULL DEFAULT 'USER_ENTERED',
    CHECK (case_id IS NOT NULL OR project_id IS NOT NULL)
);

CREATE TABLE audit_logs (
    audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    actor_officer_id uuid REFERENCES officers(officer_id),
    action varchar(40) NOT NULL,
    table_name varchar(120) NOT NULL,
    record_id uuid,
    request_id uuid,
    source_ip inet,
    old_values jsonb,
    new_values jsonb,
    reason text
);

-- Derived, rebuildable projections. They are not the source of truth.
CREATE TABLE ml_case_feature_snapshots (
    snapshot_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id uuid NOT NULL REFERENCES acquisition_cases(case_id) ON DELETE CASCADE,
    as_of_at timestamptz NOT NULL,
    prediction_horizon_days integer NOT NULL DEFAULT 30,
    feature_version varchar(80) NOT NULL,
    label_policy_version varchar(80),
    data_origin data_origin NOT NULL DEFAULT 'USER_ENTERED',
    features jsonb NOT NULL,
    censoring_flag boolean NOT NULL DEFAULT false,
    y_delay boolean,
    label_delay_days numeric(12,2),
    generated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (case_id, as_of_at, prediction_horizon_days, feature_version),
    CHECK (prediction_horizon_days > 0),
    CHECK (label_delay_days IS NULL OR label_delay_days >= 0),
    CHECK (label_policy_version IS NOT NULL OR (y_delay IS NULL AND label_delay_days IS NULL))
);

CREATE TABLE dashboard_case_daily_snapshot (
    snapshot_date date NOT NULL,
    case_id uuid NOT NULL REFERENCES acquisition_cases(case_id) ON DELETE CASCADE,
    project_id uuid NOT NULL REFERENCES land_acquisition_projects(project_id),
    district_id uuid NOT NULL REFERENCES districts(district_id),
    current_stage_id uuid REFERENCES acquisition_stages(stage_id),
    current_stage_age_days integer NOT NULL,
    progress_percent numeric(6,3),
    overdue_milestone_count integer NOT NULL DEFAULT 0,
    unresolved_objection_count integer NOT NULL DEFAULT 0,
    unresolved_parcel_count integer NOT NULL DEFAULT 0,
    pending_compensation_amount numeric(18,2) NOT NULL DEFAULT 0,
    open_legal_case_count integer NOT NULL DEFAULT 0,
    risk_level risk_level,
    delay_probability numeric(6,5),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (snapshot_date, case_id),
    CHECK (current_stage_age_days >= 0),
    CHECK (progress_percent IS NULL OR progress_percent BETWEEN 0 AND 100),
    CHECK (overdue_milestone_count >= 0),
    CHECK (unresolved_objection_count >= 0),
    CHECK (unresolved_parcel_count >= 0),
    CHECK (pending_compensation_amount >= 0),
    CHECK (open_legal_case_count >= 0),
    CHECK (delay_probability IS NULL OR delay_probability BETWEEN 0 AND 1)
);

CREATE INDEX idx_districts_state ON districts(state_id);
CREATE INDEX idx_officers_department_district ON officers(department_id, district_id);
CREATE INDEX idx_projects_district_status ON land_acquisition_projects(district_id, status);
CREATE INDEX idx_projects_target_date ON land_acquisition_projects(approved_target_date);
CREATE INDEX idx_cases_project_status ON acquisition_cases(project_id, status);
CREATE INDEX idx_cases_scope_owner ON acquisition_cases(district_id, current_department_id, current_officer_id);
CREATE INDEX idx_case_stages_active ON case_stages(case_id, status) WHERE status IN ('ACTIVE', 'BLOCKED');
CREATE UNIQUE INDEX uq_case_stages_one_active ON case_stages(case_id) WHERE status = 'ACTIVE';
CREATE INDEX idx_case_stages_dates ON case_stages(actual_start_at, actual_end_at, planned_end_at);
CREATE INDEX idx_milestones_overdue ON milestones(case_id, planned_at) WHERE status IN ('PENDING', 'IN_PROGRESS', 'OVERDUE');
CREATE INDEX idx_milestones_owner ON milestones(owning_department_id, assigned_officer_id, status);
CREATE INDEX idx_case_parcels_unresolved ON case_parcels(case_id) WHERE resolution_status <> 'RESOLVED';
CREATE INDEX idx_case_landowners_case ON case_landowners(case_id);
CREATE INDEX idx_documents_case_status ON documents(case_id, status);
CREATE INDEX idx_notices_case_status ON notices(case_id, status);
CREATE INDEX idx_hearings_case_schedule ON hearings(case_id, scheduled_at);
CREATE INDEX idx_objections_open ON objections(case_id, received_at) WHERE status NOT IN ('RESOLVED', 'WITHDRAWN', 'REJECTED');
CREATE INDEX idx_legal_cases_open ON legal_cases(case_id, filed_at) WHERE status IN ('OPEN', 'STAYED');
CREATE INDEX idx_model_versions_status ON model_versions(deployment_status, created_at DESC);
CREATE INDEX idx_risk_policies_active ON risk_policies(status, effective_from DESC);
CREATE INDEX idx_risk_case_time ON risk_assessments(case_id, assessment_at DESC);
CREATE INDEX idx_rule_evaluations_assessment ON rule_evaluations(risk_assessment_id, rule_code);
CREATE INDEX idx_rule_evaluations_case_time ON rule_evaluations(case_id, evaluated_at DESC);
CREATE INDEX idx_predictions_case_time ON predictions(case_id, predicted_at DESC);
CREATE INDEX idx_prediction_factors_prediction_rank ON prediction_factors(prediction_id, rank);
CREATE INDEX idx_prediction_factors_direction ON prediction_factors(prediction_id, direction);
CREATE INDEX idx_model_feature_importance_rank ON model_feature_importance(model_version, rank);
CREATE INDEX idx_prediction_recommendations_rank ON prediction_recommendations(prediction_id, rank);
CREATE INDEX idx_alerts_queue ON alerts(status, priority, triggered_at);
CREATE INDEX idx_alerts_case ON alerts(case_id, status);
CREATE INDEX idx_recommendations_queue ON recommendations(status, due_at);
CREATE INDEX idx_events_case_time ON historical_events(case_id, occurred_at);
CREATE INDEX idx_events_project_time ON historical_events(project_id, occurred_at);
CREATE INDEX idx_audit_record_time ON audit_logs(table_name, record_id, occurred_at DESC);
CREATE INDEX idx_audit_actor_time ON audit_logs(actor_officer_id, occurred_at DESC);
CREATE INDEX idx_feature_snapshots_case_time ON ml_case_feature_snapshots(case_id, as_of_at DESC);
CREATE INDEX idx_dashboard_district_date ON dashboard_case_daily_snapshot(district_id, snapshot_date);
CREATE INDEX idx_dashboard_risk_date ON dashboard_case_daily_snapshot(risk_level, snapshot_date);

-- Requires PostGIS. If spatial search is not needed in the first deployment,
-- remove the geometry column and this index together.
CREATE INDEX idx_parcels_geometry ON parcels USING gist (geometry);