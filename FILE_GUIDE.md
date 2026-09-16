# File Guide

Every file in this repository, and what it is for.

The project is a land acquisition delay prediction and early warning platform,
split into five parts:

```text
data/       synthetic case data and the generator that produces it
ml/         model training, the prediction service, and the design documents
database/   the canonical PostgreSQL schema
backend/    the Express + Prisma API, engines, and authorization
frontend/   the React officer-facing interface
```

A note on how to read the tree. `backend/dist/` and `frontend/dist/` are
compiled output, `node_modules/` is dependencies, and `__pycache__/`,
`.pytest_cache/`, and `test-results/` are tool caches. None of them are sources;
everything worth reading lives in `src/`, `test/`, `e2e/`, `prisma/`, and the
Markdown documents.

---

## Root

| File | What it is |
| --- | --- |
| `package.json` | Workspace root. Holds no dependencies of its own — only the scripts that run the three suites together (`test`, `test:all`, `typecheck`, `verify`). |
| `package-lock.json` | Lockfile for the root workspace. |
| `.gitignore` | Ignores secrets (`.env`, keys), dependencies, build output, and tool caches. The comments record two deliberate decisions: `.env.example` is kept, and ML artifacts are tracked on purpose so a fresh clone can run the model without training. |
| `SECURITY.md` | The security architecture: what is protected, against what, and how. Includes the findings of the 16 Sep 2026 review, the residual risks accepted, and the controls a deployment must supply that code cannot (TLS, headers, object storage). |
| `TESTING.md` | The testing strategy. Explains the layering — what each suite needs to run, what it catches, and why a test earns its place. |
| `DEMO_DATASET.md` | Describes the twenty-three demonstration cases and, importantly, the rule that risk is *derived from recorded facts by the engine*, never authored. |
| `FILE_GUIDE.md` | This file. |

---

## `database/` — canonical schema

| File | What it is |
| --- | --- |
| `schema.sql` | The PostgreSQL 15+ schema (647 lines). Source-of-truth tables are normalized; the two projection tables at the end are rebuildable and must never be edited as authoritative records. Uses `pgcrypto` and `postgis`, and carries a `data_origin` enum so synthetic demo rows can never be mistaken for real government data. |
| `SCHEMA.md` | The narrative explanation of that schema: the design goals (transactional correctness, temporal analysis, explainable prediction) and the reasoning behind each table group. |

Note: `backend/prisma/schema.prisma` is the ORM's view of this same design. The
SQL file is the reference; Prisma is what the application actually runs against.

---

## `data/` — synthetic dataset

| File | What it is |
| --- | --- |
| `generate_synthetic_dataset.py` | Generates 6,000 correlated synthetic land-acquisition cases. Point-in-time predictors first, outcome labels after — the ordering matters, because it is what keeps the training split honest. |
| `synthetic_land_acquisition_cases.csv` | The generated dataset, seed `20260915`. Reproducible by re-running the generator. |
| `validate_synthetic_dataset.py` | Checks the CSV against its contract: column presence, types, ranges, and the correlations the generator was supposed to produce. Catches a dataset that regenerated wrong. |
| `SYNTHETIC_DATASET.md` | Documents the dataset and states plainly that it is synthetic and must not be presented as government statistics. |

---

## `ml/` — models, service, and design documents

### Design documents

These five documents are the specification the code implements. Read them before
the code.

| File | What it is |
| --- | --- |
| `PREDICTIVE_ANALYTICS_ENGINE.md` | The engine's architecture: two independent signal layers (a transparent rule evaluator and a trained model) feeding one governed decision layer. Also defines the model registry discipline. |
| `ML_DATASET_DESIGN.md` | The model-ready dataset spec for the three outputs: `delay_probability`, `expected_additional_delay_days`, and `risk_category`. |
| `EXPLAINABLE_AI.md` | The explanation contract. A prediction is never returned as an unexplained percentage, and association is never described as causation. |
| `RECOMMENDATION_ENGINE.md` | How measured evidence becomes a ranked list of operational actions, each traceable to the value that produced it. |
| `EARLY_WARNING_SYSTEM.md` | The eleven watched conditions, their thresholds, and the anti-fatigue rules. Recommendations answer "what should be done"; alerts answer "what changed that an officer needs to see now". |

### Code

| File | What it is |
| --- | --- |
| `train_models.py` | Trains, compares, calibrates, and exports the delay classifiers. Explicitly excludes target columns, identifiers, provenance, and outcome-derived fields from the feature set. |
| `service/app.py` | The FastAPI prediction service. Loads the approved artifact and scores one case at a time. Deliberately narrow contract: a request it cannot answer well returns a *stated degradation*, not a confident guess. |
| `requirements.txt` | Runtime pins for training and inference (FastAPI, scikit-learn, pandas, numpy), set to minimums carrying security fixes. |
| `requirements-dev.txt` | Adds `pytest` and `httpx` on top of the runtime set. |

### Model artifacts (`ml/artifacts/`)

Tracked in git on purpose — 64 KB total, and it means a fresh clone can serve
predictions without a training run.

| File | What it is |
| --- | --- |
| `latest.json` | The registry pointer: which model version is current. |
| `synthetic-delay-20260915T173246Z/model.joblib` | The serialized selected model (logistic regression). |
| `.../preprocessing_pipeline.joblib` | The fitted preprocessing pipeline. Serving must use this, not a re-fitted one. |
| `.../model_metadata.json` | Version, selected model, selection basis, row counts, target. |
| `.../feature_metadata.json` | The feature contract — the exact columns and order the model expects. |
| `.../evaluation_metrics.json` | Full evaluation: CV, validation, and test metrics, with the chosen threshold. |
| `.../feature_importance_shap.json` | Permutation importance per feature, feeding the explanation layer. |
| `.../skipped_models.json` | Records that XGBoost and CatBoost were not installed, so their absence reads as a known condition rather than a silent omission. |

### ML tests (`ml/tests/`)

Written as `unittest.TestCase` so they run under pytest *and* the standard
library runner. Each suite skips rather than fails when an artifact is absent —
a fresh clone has not trained a model, and that is not a regression.

| File | What it checks |
| --- | --- |
| `ml_test_base.py` | Shared helpers and the skip-when-absent behaviour. |
| `test_data_leakage.py` | The three leakage modes this pipeline could plausibly suffer: target in the features, an identifier letting the model memorise rows, and a temporal split that reads the future. |
| `test_feature_consistency.py` | Dataset, artifact, and serving path agree on columns. Guards a silent failure: a renamed column produces predictions that are *wrong*, not predictions that fail. |
| `test_model_loading.py` | Loads the artifact as a serving process would and scores awkward inputs: one row, an empty frame, unseen categories, missing values. |
| `test_model_version_compatibility.py` | Registry discipline — a resolvable pointer, complete metadata, metrics clearing the operational floor, a satisfiable feature contract. |
| `test_prediction_schema.py` | The response contract from the model side: every promised field, in range, with risk bands covering the whole probability interval. |
| `test_service_contract.py` | The backend↔service payload agreement. Written after a real bug: the backend once sent five fields of operational metadata, none of them training columns, so every request arrived with the feature vector missing — and the model still returned a confident-looking number. |

---

## `backend/` — API, engines, authorization

### Configuration and docs

| File | What it is |
| --- | --- |
| `README.md` | How to run the API locally. |
| `ACCESS_CONTROL.md` | The three authorization gates and why neither permission nor scope substitutes for the other. |
| `package.json` | Express 5, Prisma 6, Zod, helmet, JWT. Scripts for dev, build, migrations, seeds, and the test layers. |
| `tsconfig.json` / `tsconfig.test.json` | Build config, and a wider config that type-checks the test tree too. |
| `.env.example` | The environment contract. The API refuses to boot without `DATABASE_URL` and `JWT_SECRET`. |

### Entry points

| File | What it is |
| --- | --- |
| `src/server.ts` | Starts the listener. Seven lines — kept separate so the app can be imported by tests without binding a port. |
| `src/app.ts` | Assembles the Express app: security middleware, request context, routes, Swagger UI, error handlers. Sets `trust proxy` explicitly, because audited IPs and rate-limit buckets are only meaningful when the proxy chain is declared. |

### Configuration (`src/config/`)

| File | What it is |
| --- | --- |
| `env.ts` | Zod-validated environment. Invalid config fails at boot, not at runtime. |
| `prisma.ts` | The shared Prisma client. Two lines. |
| `logger.ts` | Structured logging built from *named fields*, never spread objects — spreading is how case data and tokens end up in a log aggregator. No bodies, no query values; stack traces only outside production. |
| `cors.ts` | Cross-origin allow-list parsing, kept free of framework imports so it can be unit-tested alone. |
| `openapi.ts` | The OpenAPI 3.0.3 document served at `/docs`. Its description states that predictions are not statutory decisions. |

### Middleware (`src/middlewares/`)

Applied in a fixed order on every protected route:
`authenticate → attachScope → requirePermission → validate → enforceScope → audit → handler`

| File | What it is |
| --- | --- |
| `security.ts` | Headers, CORS, body size limits, rate limiting. Documents why Bearer-token auth means classic CSRF does not apply — and what becomes mandatory if cookies are ever introduced. |
| `requestContext.ts` | Assigns or propagates `x-request-id` so a client error can be traced to a log line. |
| `auth.ts` | Issues and verifies JWTs. Pins algorithm, issuer, and audience — without an algorithm pin, the *attacker* picks the algorithm. Establishes identity only; never authority. |
| `authorize.ts` | The security boundary. Three gates: `requireRole`, `requirePermission`, `enforceScope`. Every refusal is audited before it is returned. |
| `validate.ts` | Runs a Zod schema over params, query, and body, replacing them with the parsed values. |
| `audit.ts` | Wraps mutating routes to capture before/after snapshots and write one audit row on completion — so a request rejected at validation is not recorded as a successful change. |
| `errorHandler.ts` | Clients learn a code, a curated message, and their request id. Never a stack trace, a database message, or their input reflected back. Validation is the one case where field-level detail is returned. |

### Authorization (`src/authz/`)

| File | What it is |
| --- | --- |
| `permissions.ts` | The single source of truth for the role→permission matrix. Routes reference permissions, never roles, so widening a role is one table edit rather than a hunt through the router. |
| `scope.ts` | Geographic and departmental row filtering. **Fails closed**: a role missing its state or district assignment gets an empty scope, matching no rows — granting wider access on missing data is the mistake this avoids. |
| `subjects.ts` | Loads the state/district/department of the row being touched, walking to the owning project for resources that do not carry those columns. |

### Audit (`src/audit/`)

| File | What it is |
| --- | --- |
| `auditPolicy.ts` | Declares which actions are recorded and whether the caller's IP is captured. IP is *off* by default — it is personal data, recorded only where it supports a security investigation (auth, account admin, deletions, exports, personal documents). |
| `auditService.ts` | Writes audit rows. A failed audit write is logged and the request continues: losing a row is bad, but failing a legitimate request because the audit table is down is worse. |
| `redact.ts` | Strips credentials from audit payloads at any nesting depth. No database or framework imports, so it can be reasoned about and tested alone. |

### The three engines

All three are **pure and deterministic** — no database, clock, or network — so
the same input always yields the same output, and their policies are versioned
configuration stamped onto every row they produce.

**Prediction — `src/predictions/ruleEngine.ts`**
Layer one of the predictive engine: a transparent evaluator scoring the same
point-in-time snapshot the model reads. It answers when no model service is
configured, and it is deliberately *explainable rather than accurate* — every
contribution names the measurement behind it. Combines by noisy-OR rather than
summing, so a handful of ordinary problems cannot imply certainty, and
correlated rules are grouped so one underlying issue is not counted three times.

**Recommendations — `src/recommendations/`**

| File | What it is |
| --- | --- |
| `engine.ts` | Ranks and emits actions. Returns the component scores that produced the ranking alongside the result. |
| `catalog.ts` | Every recommendation the engine can ever produce. An entry fires only when its `extract` function finds a *measured value* — no action without evidence. |
| `policy.ts` | Every number used to rank, prioritize, or schedule. Nothing hardcoded in the scoring logic. |
| `wording.ts` | Controlled language. Rejects causal verbs and certainty claims by regex, so a carelessly edited template cannot put "will reduce" on an officer's screen. |
| `types.ts` | The contract: everything emitted must be derivable from a declared input block. |
| `index.ts` | Public surface of the module. |

**Early warning — `src/alerts/`**

| File | What it is |
| --- | --- |
| `detectors.ts` | The individual condition detectors. Each reads named measurements and returns a condition or null. A detector never decides whether anyone is notified. |
| `engine.ts` | Decides what each detected condition means for the alert that already exists: raise, escalate, leave, or resolve. The anti-fatigue controls are the point — one live alert per project and type, a quantized condition hash so an unchanged condition never re-raises, per-severity cooldowns an escalation may break, and correlation groups so one signal pages once. |
| `policy.ts` | Thresholds, severity ladders, cooldowns, notification budget. Changing when officers get paged is a reviewable config change. |
| `types.ts` | The input contract: a detector may only fire on a measured value present in a declared block. |
| `index.ts` | Public surface of the module. |

### Services (`src/services/`)

The layer between HTTP and the engines. Services assemble inputs from the
database and persist what the engines decided — they never re-decide.

| File | What it is |
| --- | --- |
| `caseSnapshot.ts` | Converts stored rows into measured values. Shared by the recommendation and alert paths so both see the same numbers. Returns `undefined` where the schema cannot evidence a measurement, so the engines report the gap instead of assuming a value. |
| `predictionService.ts` | Calls the model service, treating it as an **untrusted upstream**: pins the scheme, refuses redirects, bounds response size and time, and validates the shape before any of it is used. |
| `alertService.ts` | Assembles detector input, runs the engine, persists its decisions. One row per project and type, an immutable event per state change, a history row only when something changed. |
| `recommendationService.ts` | Same pattern for recommendations. Performs no ranking of its own. |
| `dashboardService.ts` | Computes every dashboard figure from stored rows — the table, the six-month trend, the district heatmap. Nothing authored, nothing held in the frontend. |
| `analyticsService.ts` | Scoped aggregates. The scope filter is applied *before* the count, because an aggregate over out-of-scope rows leaks just as surely as returning them. |
| `authService.ts` | Login. Every failure looks identical (same status, message, and comparable work) so responses cannot reveal whether an account exists or is locked; repeated failures lock the account; both outcomes are audited with the caller's address. |
| `userService.ts` | Account administration. Blocks privilege escalation — an admin may only assign a role at or below their own — and applies scope to people as well as projects. |
| `projectService.ts` | Project CRUD and milestones. List reads are scope-filtered here; single reads are gated by middleware. |

### Controllers, routes, and support

| File | What it is |
| --- | --- |
| `src/routes/index.ts` | The router. Every protected route declares its permission, its scope check, and its audit action explicitly — reading this file alone answers "who can do this, to which rows, and is it recorded". |
| `src/controllers/*.ts` | Thin HTTP adapters, one per resource: `auth`, `authz`, `user`, `project`, `prediction`, `recommendation`, `alert`, `analytics`, `audit`, `document`. They unwrap the request and call a service. `documentController.ts` is the one with real logic worth noting — it never returns `storageKey`, since knowing it is a step towards reaching the object outside this API's authorization. |
| `src/validators/schemas.ts` | Every route's Zod schemas. Bodies are **strict** — an unexpected field is refused, not silently dropped, because silent stripping hides both client bugs and attackers probing for fields. Text is length-bounded and rejects control characters. |
| `src/repositories/projectRepository.ts` | Prisma queries for projects. The scope filter is a *required* argument, so a new caller cannot forget it and read the whole estate. |
| `src/errors/AppError.ts` | The typed error carrying status, code, and optional details. |
| `src/models/api.ts` | Shared response types (`ApiResponse`, `PredictionResponse`, `RiskFactor`). |
| `src/shared/hash.ts` | Deterministic FNV-1a fingerprints for condition hashes that must stay stable across runs. Documented as non-cryptographic. |
| `src/utils/pagination.ts` | Page/pageSize parsing with bounds, and the paged result envelope. |
| `src/types/express.d.ts` | Augments Express's `Request` with `requestId`, `user`, scope, and the loaded subject. |

### Database and seeds (`backend/prisma/`, `backend/scripts/`)

| File | What it is |
| --- | --- |
| `prisma/schema.prisma` | The Prisma model of the schema — roles, projects, milestones, documents, predictions, recommendations, alerts, audit rows. |
| `prisma/seed.ts` | One account per role, each with a distinct geographic scope, so role and scope behaviour can be exercised end to end. Demo environments only. |
| `prisma/demoDataset.ts` | The twenty-three demonstration cases (1,347 lines): clean corridors, drifted paperwork, aged compensation, cases under court order. Each records facts and an `expectedRisk` the authors believe those facts describe — a test runs the engine and fails if the two disagree. |
| `prisma/seedDemo.ts` | Writes the cases, then lets the real engines do everything else: risk from the rule engine, recommendations from the recommendation engine, alerts from the detectors, and six months of prediction history per project so the trend chart aggregates real rows. |
| `scripts/generateDemoFallback.ts` | Generates the frontend's offline data (`frontend/src/data.ts`) from the same dataset, the same rule engine, and the same aggregation rules as the API. A hand-authored fallback would drift from the database and turn the demo into a lie the first time a case fact changed. |

### Backend tests (`backend/test/`)

| File | What it checks |
| --- | --- |
| `fixtures/edgeCases.ts` | Realistic case records that have broken something, or could — shared so one awkward shape is exercised by every engine that must survive it. |
| `fixtures/engineInputs.ts` | Builders turning a fixture into engine input, so neither suite restates the shape. |
| `helpers/integration.ts` | The integration harness: real Express over HTTP against a real PostgreSQL, with reset and seed helpers. Skips cleanly when no database is configured. |
| `unit/riskCalculation.test.ts` | The scoring primitives and priority bands. |
| `unit/recommendationRanking.test.ts` | Ranking, policy weights, and the banned-wording guard. |
| `unit/alertGeneration.test.ts` | Detector firing, escalation, cooldowns, and the notification budget. |
| `unit/edgeCases.test.ts` | Both engines against the awkward fixtures. |
| `unit/featureEngineering.test.ts` | Snapshot reading, including the snake_case columns the feature pipeline writes. |
| `unit/validation.test.ts` | Request schemas and CORS parsing. |
| `unit/authz.test.ts` | The permission matrix — including that the frontend mirror stays in step with the backend catalogue. |
| `unit/audit.test.ts` | Redaction, IP normalization, payload limits, and policy completeness. |
| `unit/demoDataset.test.ts` | Runs the engine over every demo case and fails if derived risk disagrees with the stated expectation. |
| `integration/api.test.ts` | The API surface end to end. |
| `integration/authentication.test.ts` | Login, lockout, and token handling against the real stack. |
| `integration/security.test.ts` | Headers, rate limits, scope enforcement in SQL, and audit rows actually being written. |
| `integration/database.test.ts` | Prisma queries and constraints. |
| `integration/predictionService.test.ts` | The upstream-hardening behaviour, against a stub model server. |

---

## `frontend/` — officer interface

### Configuration

| File | What it is |
| --- | --- |
| `package.json` | React 19, Vite 7, TanStack Query, Recharts, Zod, Tailwind, Playwright. |
| `vite.config.ts` | Build config, plus a plugin injecting a strict Content Security Policy into the built HTML. Build-only, because the dev server needs inline scripts for hot reload — and a policy relaxed for development is not the policy worth shipping. |
| `playwright.config.ts` | Runs the suite against the *production build* with the API mocked at the network boundary, so it needs no database or backend and can run in a pull request. `E2E_LIVE_API` points it at a real stack instead. |
| `tailwind.config.js` / `postcss.config.js` | Tailwind content paths and the project palette; PostCSS plugin chain. |
| `tsconfig.json`, `tsconfig.app.json`, `tsconfig.node.json` | Project references for app code and Node-side tooling. |
| `index.html` | The Vite entry document. |

### Application shell

| File | What it is |
| --- | --- |
| `src/main.tsx` | Mounts React. |
| `src/App.tsx` | Providers (Query, Session, Demo) and the route table. |
| `src/layouts/AppShell.tsx` | Sidebar, top bar, notification bell, and role/scope display. Nav entries are filtered by permission. |
| `src/styles.css` | The whole stylesheet: fonts, tokens, layout, and responsive breakpoints. |
| `src/vite-env.d.ts` | Types `VITE_API_URL`. |

### Data access

| File | What it is |
| --- | --- |
| `src/api/client.ts` | Fetch wrapper. Bearer token in the header, never a cookie, with `credentials: 'omit'` stating that explicitly so ambient authority is not quietly reintroduced. Responses are parsed through Zod. |
| `src/services/dashboardService.ts` | Reads `/analytics/dashboard`. Falls back to the generated offline data when the API is unreachable. |
| `src/services/alertService.ts` | Notification centre reads and alert acknowledgement. |
| `src/services/recommendationService.ts` | Recommendation reads, with an offline fallback built from the same fields the drawer already displays — and the same hedged wording. |
| `src/hooks/useDashboard.ts`, `useNotificationCentre.ts`, `useRecommendations.ts` | TanStack Query wrappers with their caching and refetch policies. |
| `src/data.ts` | **Generated — do not edit.** The offline demo data, produced by `backend/scripts/generateDemoFallback.ts`. Regenerate with `npm --prefix backend run generate:demo-fallback`. |

### Types (`src/types/`)

`project.ts`, `alert.ts`, and `recommendation.ts` hold Zod schemas mirroring the
backend contracts. Because responses are parsed rather than cast, a drifting API
shape fails loudly at the boundary instead of rendering wrong.

### Authorization mirror (`src/auth/`)

| File | What it is |
| --- | --- |
| `permissions.ts` | A mirror of the backend catalogue. **Not a security boundary** — it exists so the interface does not offer a person a button the server will refuse. A backend test asserts the two stay in step. |
| `SessionProvider.tsx` | Holds the session, role, scope, and effective permissions. |
| `ProtectedRoute.tsx` | Route guard that renders a clear refusal rather than a blank screen. |

### Pages and features

| File | What it is |
| --- | --- |
| `src/features/dashboard/DashboardPage.tsx` | The executive dashboard: KPI tiles, risk overview, filter bar, project table. |
| `src/features/projects/ProjectDetailDrawer.tsx` | One case in full — prediction, timeline, risk factors, recommendations. |
| `src/features/analytics/AnalyticsCharts.tsx` | The composed analytics charts. |
| `src/pages/AnalyticsPage.tsx` | Portfolio analytics: trend, heatmap, department and state breakdowns. |
| `src/pages/AlertsPage.tsx` | The notification centre — alerts with their evidence, and acknowledgement. |
| `src/pages/AdminPage.tsx` | The caller's own role, scope, and permissions, plus the full matrix. |
| `src/pages/RegistryPage.tsx` | The project register. |

### Components and charts

`src/components/` holds the presentational pieces: `KpiCard`, `PanelHeader`,
`FilterBar`, `ProjectTable`, `ProjectStatusBadge`, `RiskBadge`,
`RiskFactorList`, `PredictionCard`, `ProgressTimeline`, `RecommendationCard`,
`AlertCard`, `AlertPanel`, `AnalyticsChart`, `SkeletonLoader`, `ToastViewport`.

`src/charts/` holds the three Recharts wrappers: `RiskOverviewChart`,
`DelayTrendChart`, `DistrictHeatmap`.

`src/utils/` holds `portfolio.ts` (summary figures computed from the project
rows on screen), `risk.ts` (risk labels, colours, ordering), and `toast.ts`.

### Demo mode (`src/demo/`)

| File | What it is |
| --- | --- |
| `steps.ts` | The twelve-step guided script, about two and a half minutes, so a judge can follow the argument unnarrated. Steps name their target by a `data-demo` attribute rather than a CSS selector, so restyling cannot silently break the tour. |
| `DemoModeProvider.tsx` | Owns the step index, drives route changes, and signals when a step needs the project drawer open. |
| `DemoTour.tsx` | The spotlight overlay and step controls. |
| `DemoBanner.tsx` | The entry point and duration display. |

### End-to-end tests (`frontend/e2e/`)

| File | What it checks |
| --- | --- |
| `fixtures/api.ts` | Answers every request the app makes. Payloads match the API contract — if one drifts, the app's own Zod parsing rejects it and the test fails, which is the signal wanted. |
| `dashboard.spec.ts` | Summary, charts, and table render together, and the association disclaimer travels with the risk figures. |
| `prediction.spec.ts` | Probability, factors, and the association statement appear together, and no causal claim reaches the screen. |
| `alertAcknowledgement.spec.ts` | An alert carries its evidence, acknowledging records the decision, and the queue does not re-present it. |
| `riskFiltering.spec.ts` | Filters narrow rather than reorder, combine correctly, and an empty result says so rather than looking broken. |
| `login.spec.ts` | Session handling and permission-based navigation. |
| `projectCreation.spec.ts` | The creation journey through the API against a live stack, since no create form exists in the interface yet. |
| `demoMode.spec.ts` | Every tour step finds its target, the spotlight moves, and the drawer opens when a step needs it. |
| `tsconfig.json` | Type-checks the e2e tree separately from the app. |

---

## Generated and ignored

Present on disk, not sources — safe to delete and regenerate.

| Path | What it is |
| --- | --- |
| `backend/dist/` | Compiled backend JavaScript (`tsc`). Mirrors `backend/src/`. |
| `frontend/dist/` | The production bundle (`vite build`), including the CSP-injected `index.html`. |
| `frontend/test-results/` | Playwright run output. |
| `ml/**/__pycache__/`, `ml/.pytest_cache/` | Python bytecode and pytest caches. |
| `*/package-lock.json` | Dependency lockfiles — committed, but not hand-edited. |
