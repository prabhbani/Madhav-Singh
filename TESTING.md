# Testing Strategy

The suite is built around one idea: **a test is worth writing when it would catch
a mistake somebody could realistically make.** Layers are separated by what they
need to run, so the fast checks stay fast and the slow ones stay honest about
their dependencies.

| Layer | Count | Needs | Runtime |
|---|---:|---|---:|
| Unit | 245 | nothing | ~2s |
| ML | 65 | trained artifacts, pandas, scikit-learn | ~1s |
| Integration | 5 suites | PostgreSQL | gated |
| End-to-end | 65 | a browser | ~23s |

The default command runs only what needs nothing, so a fresh clone is green
immediately. Everything else states its dependency and skips with a message
rather than failing.

---

## 1. Commands

```bash
# From the repository root
npm test                  # unit + ML. No database, no browser. The default gate.
npm run test:unit         # backend unit suites only
npm run test:ml           # ML suites under pytest
npm run test:ml:stdlib    # the same suites without pytest installed
npm run test:integration  # needs DATABASE_URL and JWT_SECRET
npm run test:e2e          # needs a browser
npm run test:all          # every layer, in order of cost
npm run typecheck         # backend and frontend, including test sources
npm run audit             # dependency advisories in both packages
npm run verify            # typecheck, audit, then the default test gate
```

Per package:

```bash
cd backend
npm run test:unit          npm run test:integration    npm run test:all
npm run test:watch         npm run test:coverage       npm run typecheck

cd frontend
npm run test:e2e:install   # one-time: downloads Chromium (~95 MB)
npm run test:e2e           npm run test:e2e:ui         npm run test:e2e:report

cd ml
PYTHONPATH=tests python3 -m pytest tests -q
PYTHONPATH=tests python3 -m unittest discover -s tests -p "test_*.py" -v
```

### Expected outcomes

| Command | Expected |
|---|---|
| `npm test` | `245 pass, 0 fail` then `63 passed, 2 skipped` |
| `npm run test:unit` | `tests 245 / pass 245 / fail 0` |
| `npm run test:ml` | `63 passed, 2 skipped` (the two skips need a second model version) |
| `npm run test:integration` without a database | 5 suites reported as skipped, each naming what to set |
| `npm run test:integration` with a database | every suite runs; no skips |
| `npm run test:e2e` | `61 passed, 4 skipped` (the four skips need `E2E_LIVE_API`) |
| `npm run typecheck` | no output |
| `npm run audit` | `found 0 vulnerabilities` twice |

### Enabling the gated layers

```bash
# Integration. Point at a disposable database: the suites truncate every table.
createdb land_acquisition_test
export DATABASE_URL="postgresql://localhost:5432/land_acquisition_test"
export JWT_SECRET="$(openssl rand -base64 48)"
npm --prefix backend run prisma:migrate
npm run test:integration

# End-to-end against the real stack rather than mocks
export E2E_LIVE_API=http://localhost:4000
npm run test:e2e
```

---

## 2. Unit tests

`backend/test/unit/`. Pure functions, no input or output of any kind, so they run
in about a second and can be trusted to fail for one reason.

| Suite | Covers |
|---|---|
| `riskCalculation.test.ts` | Severity functions, ranking weights, priority bands, alert ladders |
| `featureEngineering.test.ts` | Snapshot reading, numeric coercion, age derivation |
| `validation.test.ts` | Every request schema at the API boundary |
| `recommendationRanking.test.ts` | Evidence gating, score reconciliation, ranking order, deadlines |
| `alertGeneration.test.ts` | All eleven detectors and every anti-fatigue control |
| `edgeCases.test.ts` | The awkward case records, through both engines |
| `authz.test.ts` | Permission catalogue, role nesting, scope resolution |
| `audit.test.ts` | Redaction, IP normalization, audit policy consistency |
| `demoDataset.test.ts` | Derived risk distribution, chart variation, explainability, generated fallback |

Properties rather than examples, where the property is what matters. Severity
functions are checked to stay inside `[0,1]` for every input including infinity
and NaN, and to be monotonic across their whole range, rather than at three
hand-picked points. Ranking scores are recomputed from the breakdown each
recommendation publishes, so the score and its own explanation cannot drift
apart.

Two suites read the router source and fail if a mutating route declares no
permission or no audit action, or names a permission that is not in the
catalogue. A typo there would otherwise fail open.

---

## 3. Edge cases

`backend/test/fixtures/edgeCases.ts` holds ten case records, each with the
hazard it represents written next to it. Every one is driven through both
engines, and the output is walked recursively to assert no field anywhere is
non-finite.

| Fixture | Hazard |
|---|---|
| Nominal corridor acquisition | The control; if this fails the edge case is not the problem |
| Zero landowners | Per-owner averages divide by zero; "no objections" must not read as "no data" |
| Missing compensation data | An absent amount must not become zero, nor an ageing backlog |
| No historical data | Trend and increase detectors have nothing to compare against |
| Extremely large project | Counts three orders of magnitude past every threshold |
| Missing documents | Completeness ratio is zero with no total to divide by |
| Project already completed | A closed case must raise no new work |
| Conflicting dates | Target before start, milestone after target; date arithmetic goes negative |
| Null values | Explicit nulls rather than absent keys |
| Duplicate records | A repeated import must not double-count or re-alert |

Plus a hostile-numbers fixture where every field is NaN, infinity, or negative.

**These fixtures found a real gap.** Neither engine checked project status, so a
completed case still generated recommendations and alerts from leftover counters.
Both now refuse to raise work against a closed case, and resolve anything still
open against it. The tests that caught it are the "project already completed"
cases.

---

## 4. Integration tests

`backend/test/integration/`. These drive the real Express application over HTTP
against real PostgreSQL. That is the only way to reach what unit tests cannot:
middleware ordering, scope filters applied in SQL, audit rows actually written,
and rate limiting.

| Suite | Covers |
|---|---|
| `database.test.ts` | Unique constraints, cascade deletes, defaults, decimal precision, transaction rollback |
| `authentication.test.ts` | Login, token issuing, lockout, audit rows, expired and forged tokens |
| `api.test.ts` | Every resource route, scope filtering, audit before and after values |
| `predictionService.test.ts` | The model service as an untrusted upstream |
| `security.test.ts` | Unauthorized access, escalation, IDOR, invalid input, rate limiting |

Every application import is dynamic, because the configuration module validates
the environment at import time and would throw before a skip could take effect.
The suites truncate every table between runs, so `DATABASE_URL` must point at a
disposable database.

The prediction suite stands a stub model host in front of the API and checks
behaviour when it misbehaves: a field outside the contract is discarded rather
than relayed, an error is not surfaced to the caller, a redirect towards a
metadata endpoint is refused, a stall is cut short by the timeout, and an
oversized body is rejected. Each case falls back to the rule path.

---

## 5. End-to-end tests

`frontend/e2e/`, with Playwright. The API is mocked at the network boundary, so
the suite needs no database, no backend, and no seeded data, which keeps it
runnable in a pull request.

| Spec | Covers |
|---|---|
| `login.spec.ts` | Session establishment, demo fallback, route guards, badge counts |
| `dashboard.spec.ts` | Summary tiles, charts, project table, drawer, narrow viewport |
| `projectCreation.spec.ts` | Registry navigation and access; creation through the API when live |
| `prediction.spec.ts` | Probability, explanation, recommended actions, non-causal wording |
| `riskFiltering.spec.ts` | Risk, district and department filters, search, combinations, empty result |
| `alertAcknowledgement.spec.ts` | Severity grouping, evidence display, acknowledgement, filters |
| `demoMode.spec.ts` | The twelve-step guided tour, the synthetic-data banner, and the tour controls |

The suite runs against the production build, so the content security policy
injected at build time is exercised too.

**There is no sign-in form and no create-project form yet.** The session specs
cover what exists: the session endpoint, the demo fallback, and the role-driven
guards. The creation journey is written against the API and skipped unless
`E2E_LIVE_API` is set, so adding the form is a matter of pointing the tests at
it rather than writing the coverage from scratch.

Two conventions worth knowing when adding a spec. Playwright matches the most
recently registered route first, so the catch-all in `fixtures/api.ts` is
registered before the specific handlers, and a test's own overrides last. And
the build needs `VITE_API_URL`, or the client short-circuits to its demo data and
the mocks are never reached; the Playwright config sets it.

---

## 6. ML tests

`ml/tests/`. Written as `unittest.TestCase` classes so they run under pytest and
under the standard library runner alike. Each suite skips rather than fails when
an artifact or the dataset is absent, because a fresh clone has not trained a
model and that is not a regression.

| Suite | Covers |
|---|---|
| `test_data_leakage.py` | Target, identifier and provenance exclusion; proxy correlation; temporal split |
| `test_feature_consistency.py` | Feature typing, dataset agreement, serving-layer column contract |
| `test_prediction_schema.py` | Response contract, risk band coverage, explanation ranking |
| `test_model_loading.py` | Artifact presence, batch and single-row inference, unseen levels, missing values |
| `test_model_version_compatibility.py` | Registry pointer, metadata completeness, metric floors, rollback |

The leakage checks go beyond exact column names. A correlation check catches a
feature that is the answer wearing a different name, and a naming check catches
columns like `final_delay_days` that would pass an exact-match exclusion list
while still being the outcome.

The serving contract test is the one that earns its place in practice. It asserts
that the snake_case columns the backend reads back from a stored snapshot still
exist in the dataset. A rename on either side breaks the alert and recommendation
engines silently, because a missing key simply reads as "no evidence".

**One test records a limitation rather than asserting success.** scikit-learn's
imputer refuses a zero-row batch, so `predict_proba` on an empty frame raises.
The test asserts that it raises and explains why: a batch caller must skip an
empty page. The serving path scores one project at a time and never reaches it.

---

## 7. What is not covered

Stated plainly, because a coverage claim is only useful if its edges are known.

- **Backend middleware wiring and persistence** are covered by the integration
  suites, which do not run without a database. In a pipeline without one, that
  coverage is absent rather than passing.
- **The frontend has no component-level tests.** Behaviour is covered end to end
  through the browser instead. A component suite would be worth adding when the
  interface grows forms with their own validation.
- **Load and performance** are untested. The engines are pure and bounded, but
  nothing measures the API under concurrency.
- **Accessibility** is untested beyond a narrow-viewport check. An automated
  audit and a keyboard-navigation pass belong here.
- **Notification delivery** stops at the publish call; no adapter is exercised.
- **Model retraining** is not tested end to end. The suites check the artifacts a
  training run produced, not the run itself.

---

## 8. Continuous integration

```yaml
# Suggested shape. The gates are ordered by how fast they fail.
- npm run typecheck                 # seconds, catches the most
- npm run audit                     # fails on a high or critical advisory
- npm run test:unit                 # no services needed
- npm run test:ml                   # needs the Python toolchain
- npm run test:integration          # needs a PostgreSQL service container
- npm --prefix frontend run test:e2e:install
- npm run test:e2e                  # needs a browser
```

Integration and end-to-end need services, so a pull request from a fork may only
be able to run the first four. That is an argument for keeping the unit and ML
layers broad, which is why the edge cases live there rather than in the
integration suite.

Coverage numbers are available through `npm --prefix backend run test:coverage`.
They are reported, not gated: a threshold encourages tests that execute lines
without asserting anything useful about them.
