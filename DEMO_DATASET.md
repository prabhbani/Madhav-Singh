# Demonstration Dataset

Twenty-three land acquisition cases built for the Smart India Hackathon
walkthrough. They exist to show that the system discriminates: that a large,
clean project reads as low risk while a small, tangled one reads as critical, and
that every reading can be traced back to a recorded fact.

**Risk is derived, not authored.** Each case records measured facts. The rule
engine scores them, and the band it produces is what the dashboard shows. The
dataset declares what band the authors believe each case describes, and a test
fails if the engine disagrees. Changing a project's risk means changing its
facts.

```bash
# Seed the database, then let the engines produce everything downstream
npm --prefix backend run prisma:migrate
npm --prefix backend run prisma:seed          # accounts, one per role
npm --prefix backend run prisma:seed:demo     # the twenty-three cases
```

## 1. What the seed writes, and what it derives

The seed writes only case facts: projects, milestones, and documents. Everything
an officer actually looks at is produced by running the real engines against
those rows.

| Written by the seed | Derived by running the engines |
|---|---|
| 23 projects with their scenario facts | Rule score and risk band, per project |
| 118 milestones across seven statutory stages | Six months of prediction history per project |
| ~640 document records expanded from counts | Ranked, owned recommendations with deadlines |
| | Early warning alerts with their evidence |
| | Dashboard table, trend, and heatmap |

The seed refuses to finish if the engine disagrees with any authored band, so a
broken dataset fails loudly rather than demonstrating the wrong thing.

## 2. The distribution

| Band | Projects | Rule score range |
|---|---:|---|
| LOW | 5 | 0.00 to 0.09 |
| MEDIUM | 7 | 0.29 to 0.42 |
| HIGH | 8 | 0.63 to 0.75 |
| CRITICAL | 3 | 0.90 to 0.93 |

The bands separate cleanly, which is the point of the demo: filtering the table
by risk visibly changes it, and the heatmap colours differ district to district.

## 3. The four scenario shapes

The brief named four shapes. Each has a representative case, and the dataset
carries several variations of each so the demo does not rest on one example.

**A large, clean project is not a risky one.** Bengaluru Peripheral Ring Road
Package 4 has 1,240 affected landowners, 892 parcels, and 148 required documents.
Eleven objections remain unresolved, two documents are missing, and compensation
has been in processing for eighteen days. It scores 0.03, LOW. Scale is not
risk, and a system that confuses the two wastes officer attention on the largest
projects rather than the most troubled ones.

**Paperwork drift is the early warning case.** Ludhiana Ring Road Phase II has
eleven of eighty-eight documents missing, thirteen awaiting verification, and a
declaration milestone eighteen days overdue after two earlier slips. It scores
0.31, MEDIUM. Nothing is broken; this is the moment intervention is cheapest,
and the moment it is easiest to miss.

**Three bottlenecks with three different owners.** Amritsar-Jalandhar Expressway
Package 3 has sixty-eight parcels with disputed title, compensation ninety-four
days in processing, and two civil suits. It scores 0.75, HIGH. The value of the
recommendation ranking shows here: the three problems belong to the Land Records
Department, Finance, and Legal respectively, and the queue tells each of them
what to do rather than telling the project manager that the project is late.

**A governed hard stop.** Gurugram-Sohna Elevated Corridor is under a High Court
stay order. It scores 0.90, CRITICAL, and the stay order leads the explanation
regardless of every other measurement. The recommendation is to refer the matter
to Legal and hold any acquisition step the order restrains, which is the one case
where the system tells an officer to stop rather than to act.

## 4. Every project

| Project | State / district | Scenario in one line | Score | Band | Leading factor |
|---|---|---|---:|---|---|
| Bengaluru Peripheral Ring Road Package 4 | Karnataka / Bengaluru Rural | A large expressway package with 1,240 affected landowners and only 11 unresolved objections. | 0.03 | LOW | Compensation ageing in processing |
| Kochi Water Supply Augmentation Main | Kerala / Ernakulam | A narrow pipeline corridor through mostly government land. | 0.09 | LOW | Unresolved landowner objections |
| Nashik Solar Park Transmission Corridor | Maharashtra / Nashik | A transmission line taking narrow tower footprints rather than continuous land. | 0.07 | LOW | Required documents missing |
| Surat Riverfront Access Road | Gujarat / Surat | An urban road where the municipality already held most of the land. | 0.09 | LOW | Unresolved ownership records |
| Coimbatore Western Bypass Package 2 | Tamil Nadu / Coimbatore | A bypass in its final stage. | 0.00 | LOW | Required documents missing |
| Ludhiana Ring Road Phase II | Punjab / Ludhiana | A moderate corridor where documents have fallen behind and the declaration milestone has slipped twice. | 0.29 | MEDIUM | Required documents missing |
| Nagpur Metro Reach 3 Extension | Maharashtra / Nagpur | A metro extension where eighteen submitted documents are sitting unverified. | 0.31 | MEDIUM | Documents awaiting verification |
| Jaipur Outer Ring Road Package 6 | Rajasthan / Jaipur | Fifty-eight objections outstanding, thirteen documents missing, and six approvals queued behind a single sanctioning officer. | 0.39 | MEDIUM | Unresolved landowner objections |
| Bhopal Water Grid Feeder Canal | Madhya Pradesh / Bhopal | Compensation has been in processing for seventy-four days, well past the departmental window but not yet a crisis. | 0.34 | MEDIUM | Compensation ageing in processing |
| Vijayawada Industrial Access Corridor | Andhra Pradesh / NTR | The declaration stage has been open eighty-one days against a fifty-five day baseline, with five approvals and three blocked dependencies behind it. | 0.36 | MEDIUM | Stage older than its baseline |
| Rajkot Eastern Bypass | Gujarat / Rajkot | Fourteen required documents are outstanding on a case file of sixty-two, and the survey milestone is three weeks late. | 0.42 | MEDIUM | Required documents missing |
| Guwahati Railway Over Bridge Approach | Assam / Kamrup Metropolitan | Four dependencies are blocked between the railway and the municipal corporation. | 0.38 | MEDIUM | Unresolved ownership records |
| Amritsar-Jalandhar Expressway Package 3 | Punjab / Amritsar | Sixty-eight parcels with disputed title, compensation ninety-four days in processing, and two civil suits filed. | 0.74 | HIGH | Unresolved ownership records |
| Pune Outer Ring Road Package 7 | Maharashtra / Pune | Sixty-eight unresolved objections against 312 landowners, with forty-one parcels of unresolved title behind them. | 0.73 | HIGH | Current milestone overdue |
| Chennai Peripheral Logistics Hub | Tamil Nadu / Chengalpattu | Compensation has been in processing for 118 days against a forty-five day window, with the disbursement milestone sixty-three days overdue. | 0.75 | HIGH | Current milestone overdue |
| Kanpur Defence Corridor Link Road | Uttar Pradesh / Kanpur Nagar | Thirty-eight parcels of unresolved title, seven approvals stacked in one queue, and four milestones already rescheduled. | 0.71 | HIGH | Stage older than its baseline |
| Nashik-Sinnar Industrial Corridor | Maharashtra / Nashik | Sixty-two objections outstanding, twenty-four documents missing, and the declaration thirty-nine days late. | 0.74 | HIGH | Required documents missing |
| Patna Ganga Path Eastern Extension | Bihar / Patna | Three civil suits over compensation rates, with payment eighty-one days in processing behind them. | 0.63 | HIGH | Open legal cases |
| Indore Metro Depot Land Assembly | Madhya Pradesh / Indore | A compact depot site where twenty-four of ninety-four parcels have contested title. | 0.75 | HIGH | Unresolved ownership records |
| Hubballi-Ankola Railway Link Section 2 | Karnataka / Dharwad | Forty-one objections, twenty-two missing documents, and four dependencies blocked across three departments. | 0.74 | HIGH | Stage older than its baseline |
| Mumbai Coastal Freight Corridor Package 2 | Maharashtra / Mumbai Suburban | Severe ownership disputes across 142 parcels, 218 unresolved objections, six civil suits, and a declaration milestone 187 days overdue. | 0.93 | CRITICAL | Open legal cases |
| Gurugram-Sohna Elevated Corridor | Haryana / Gurugram | A High Court stay order is in force. | 0.90 | CRITICAL | Active stay order |
| Varanasi Ring Road Phase III | Uttar Pradesh / Varanasi | Compensation of 1. | 0.92 | CRITICAL | Open legal cases |

## 5. Why the dashboard cannot drift from the database

The dashboard reads one endpoint, `GET /api/v1/analytics/dashboard`, which
computes the table, the six-month trend, and the district heatmap from stored
rows and scopes them to the caller. Progress is the share of milestones
completed. The stage is the earliest open milestone. The leading risk factor is
the first entry in the stored explanation, so the table and the detail drawer
agree because they read the same row.

When the API is unreachable the interface still renders, from
`frontend/src/data.ts`. That file is **generated**, not written:

```bash
npm --prefix backend run generate:demo-fallback
```

The generator reads the same dataset, scores it with the same rule engine, and
applies the same aggregation rules as the API. A test regenerates the file and
fails if the committed copy differs, so the offline copy cannot drift from the
database. The dashboard labels which source it used, so nobody has to guess.

## 6. Explainability

Every prediction stores its explanation alongside it: the rule score, the group
contributions, and the ranked factors, each naming its measured value, its
threshold, and what it contributed. The wording is checked by the same controlled
language guard the recommendation engine uses, so no explanation claims that a
factor caused anything or that an action will fix it.

A worked example, from the stored explanation for Amritsar-Jalandhar Package 3:

```text
Rule score 0.75, HIGH
  legal          0.399   68 of 287 parcels have unresolved ownership records
  schedule       0.282   the disbursement milestone is 38 days overdue
  readiness      0.246   compensation has been in processing for 94 days
  administrative 0.120   7 approvals remain pending in the queue
  stakeholder    0.097   47 of 394 landowners have unresolved objections

Combination: noisy-OR across the five groups, so distinct bottlenecks compound
without any single one implying certainty. Correlated measurements collapse into
one group first, so a dispute visible as both objections and title defects is not
counted twice.
```

## 7. Verifying the dataset

```bash
npm --prefix backend run test:unit        # includes the dataset suite
```

Twenty-two checks cover the distribution, the band separation, the spread of
scores and expected delays, the district and trend variation, the presence of
every trajectory shape, the four named scenario shapes, explanation quality and
non-causal wording, and whether the generated fallback is current.

## 8. Demo mode

The interface carries a guided twelve-step walkthrough for evaluation, timed at
about two and a half minutes. Press **Guided tour** in the demo banner, or take
the invitation card on the dashboard.

| Step | Shows | Anchored to |
|---:|---|---|
| 1 | Executive dashboard | `dashboard-heading` |
| 2 | Total active acquisition projects | `kpi-total` |
| 3 | High-risk projects | `kpi-high-critical` |
| 4 | One critical project, opened | `project-detail` |
| 5 | Predicted delay probability | `prediction-probability` |
| 6 | Expected delay in days | `prediction-delay` |
| 7 | Why the system considers it risky | `why-card` |
| 8 | Top risk factors | `risk-factors` |
| 9 | Recommended preventive actions | `recommended-actions` |
| 10 | Early warning alert | `alert-card` |
| 11 | Officer acknowledgement | `alert-acknowledge` |
| 12 | Department and district trends | `analytics-charts` |

Steps navigate between routes and open the project drawer themselves, so nobody
has to drive. Autoplay runs by default and pauses the moment anyone takes
control. Arrow keys step, space pauses, escape exits, and the progress dots jump
to any step, which is what a presenter at a podium needs.

The acknowledgement step leaves its button clickable rather than only pointing at
it: the spotlight takes no pointer events, so a judge can press it and watch the
alert change state.

Steps name their targets by `data-demo` attributes rather than by class, so
restyling a component cannot silently break the tour. An end-to-end suite walks
all twelve steps and fails if any one of them cannot find its target, because
that is a failure that otherwise only appears at the podium.

### Not faking government data

A red banner is fixed to the top of every screen, in and out of the tour. It
states that the data is synthetic, that it is not live government records, and
that no real landowner, compensation, or case information appears anywhere. The
tour card repeats the label on every step, the dashboard and analytics headers
carry a data-origin pill naming the source, and every project is stored with
`dataOrigin = SYNTHETIC_DEMO`, which the recommendation and alert engines attach
as a limitation to everything they produce.
