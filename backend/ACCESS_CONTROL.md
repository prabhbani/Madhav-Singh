# Access Control

Authorization runs in three independent gates, and a request must pass all of
them. Holding a permission answers "may this role do this at all". Scope answers
"may this user do it to these rows". Neither substitutes for the other.

```text
request
   |
   v
authenticate      verify the token, establish who the caller is
   |
   v
attachScope       resolve the caller's geographic and departmental reach
   |
   v
requirePermission the route's permission, from the catalogue
   |
   v
validate          the request shape, before its ids are used
   |
   v
enforceScope      load the target row and confirm it is inside scope
   |
   v
audit             record actor, action, resource, before and after
   |
   v
handler
```

**The server is the security boundary.** The frontend hides pages and buttons a
role cannot use, because offering someone a control that will be refused is bad
design. Nothing there is trusted. Anyone can edit what runs in a browser, so
every permission is checked again on the server, and the server's answer is the
only one that decides anything.

## 1. Where it lives

| Concern | File |
|---|---|
| Permission catalogue and role matrix | `src/authz/permissions.ts` |
| Scope resolution, filters, validation | `src/authz/scope.ts` |
| Scope attributes per resource | `src/authz/subjects.ts` |
| Role, permission, and scope middleware | `src/middlewares/authorize.ts` |
| Audit policy: what is recorded, and whether the IP is | `src/audit/auditPolicy.ts` |
| Audit writing | `src/audit/auditService.ts` |
| Redaction and IP normalization, dependency-free | `src/audit/redact.ts` |
| Audit middleware | `src/middlewares/audit.ts` |
| Route wiring, one line per route | `src/routes/index.ts` |
| Account administration and escalation guard | `src/services/userService.ts` |
| Frontend mirror, guards, session | `frontend/src/auth/` |
| Tests | `test/authz.test.ts`, `test/audit.test.ts` |

## 2. Roles and permissions

Six roles. Permission counts: 29, 28, 22, 15, 9, 6.

| Permission | SUPER | STATE | DISTRICT | PROJECT | ANALYST | VIEWER |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| `projects:read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `projects:create` | ✓ | ✓ | ✓ | · | · | · |
| `projects:update` | ✓ | ✓ | ✓ | ✓ | · | · |
| `projects:delete` | ✓ | ✓ | · | · | · | · |
| `cases:read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `cases:create` | ✓ | ✓ | ✓ | ✓ | · | · |
| `cases:update` | ✓ | ✓ | ✓ | ✓ | · | · |
| `cases:delete` | ✓ | ✓ | ✓ | · | · | · |
| `documents:read` | ✓ | ✓ | ✓ | ✓ | ✓ | · |
| `documents:create` | ✓ | ✓ | ✓ | ✓ | · | · |
| `documents:update` | ✓ | ✓ | ✓ | ✓ | · | · |
| `documents:delete` | ✓ | ✓ | ✓ | · | · | · |
| `predictions:read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `predictions:create` | ✓ | ✓ | ✓ | ✓ | ✓ | · |
| `analytics:read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `analytics:export` | ✓ | ✓ | · | · | ✓ | · |
| `alerts:read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `alerts:acknowledge` | ✓ | ✓ | ✓ | ✓ | · | · |
| `alerts:manage` | ✓ | ✓ | ✓ | · | · | · |
| `alerts:evaluate` | ✓ | ✓ | ✓ | · | · | · |
| `recommendations:read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `recommendations:generate` | ✓ | ✓ | ✓ | ✓ | · | · |
| `recommendations:manage` | ✓ | ✓ | ✓ | · | · | · |
| `users:read` | ✓ | ✓ | ✓ | · | · | · |
| `users:create` | ✓ | ✓ | · | · | · | · |
| `users:update` | ✓ | ✓ | · | · | · | · |
| `users:deactivate` | ✓ | ✓ | · | · | · | · |
| `auditLogs:read` | ✓ | ✓ | · | · | · | · |
| `auditLogs:export` | ✓ | · | · | · | · | · |

Four choices in this table are deliberate and worth stating.

- **VIEWER has no `documents:read`.** Case documents hold landowner records and
  personal details. A read-only observer gets case status, predictions, and
  aggregates, not the personal file.
- **ANALYST holds `analytics:export` but no operational write.** Bulk extraction
  is an analyst's job; changing a case is not. Their only non-read permission
  besides export is `predictions:create`, which computes rather than edits.
- **`projects:delete` stops at STATE_ADMIN.** A delete is an archive here, setting
  status to `CANCELLED`, but it still removes a project from every officer's
  working view, so it stays with the administrator roles.
- **Audit access stops at the two administrator roles**, and export at
  SUPER_ADMIN alone. A state administrator's audit view is additionally narrowed
  by scope.

The four officer roles nest strictly: every PROJECT_OFFICER permission is held by
DISTRICT_OFFICER, and so on up to SUPER_ADMIN. A test asserts the containment, so
a future edit cannot quietly give a narrower role something a wider one lacks.
ANALYST sits outside that chain on purpose; it is a different axis, not a rung.

`cases` covers the per-case workflow records. In the operational schema those are
the milestone rows hanging off a project, and the routes bind accordingly. The
permission is named at the domain level so it still applies when the full case
entity from `database/schema.sql` lands.

## 3. Scope

| Role | Widest scope | Requires |
|---|---|---|
| SUPER_ADMIN | Global | nothing |
| STATE_ADMIN | State | an assigned state |
| DISTRICT_OFFICER | District | an assigned district |
| PROJECT_OFFICER | Department | an assigned department |
| ANALYST | State | an assigned state |
| VIEWER | State | an assigned state |

The effective scope is the narrower of the role's ceiling and what the account
actually has assigned.

**Scope resolution fails closed.** A STATE_ADMIN with no state resolves to an
empty scope, which matches no rows at all. The alternative, treating a missing
assignment as "no restriction", turns an incomplete account into an unrestricted
one, and that is the mistake this avoids. A blank or whitespace assignment counts
as missing, not as a wildcard.

User scope columns hold the same identifier space as `projects.state` and
`projects.district`, and are compared case-insensitively after trimming, so a
casing difference cannot deny a legitimate request.

### Scope is applied twice

A single-row route is checked by `enforceScope`, which loads the target and
refuses when it falls outside. That is not enough on its own: a collection route
never touches `enforceScope`, so **every list, aggregate, and export applies a
scope filter in its query**. Project lists, analytics counts, risk trends, the
alert queue, the notification centre, alert history, dataset export, and the
account list are all filtered before the database answers. An aggregate computed
over out-of-scope rows leaks the same information as returning them.

The alert sweep, `POST /alerts/evaluate`, is filtered too. It returns only
counts, but an unfiltered sweep would write alerts against, and send
notifications about, projects the caller has no authority over.

A denial names the caller's scope and never the attributes of the row they could
not reach, so a 403 cannot be used to probe for records.

## 4. Privilege escalation

Account administration carries two rules beyond the permission check.

- **No assigning a role above your own.** Roles are ranked, and an administrator
  may only assign at or below their own rank. A STATE_ADMIN cannot mint a
  SUPER_ADMIN, cannot promote anyone past themselves, and cannot edit an account
  that already outranks them.
- **No moving an account out of your scope.** A scoped administrator creates and
  edits accounts inside their own state or district, and cannot relocate one
  outside it. New accounts inherit the administrator's scope by default.

Deactivating your own account is refused, so an administrator cannot lock
themselves out in a single call.

## 5. Audit

Every mutating route records one row. A test walks the router and fails if a
mutating route declares no audit action, and another fails if one declares no
permission, so the coverage cannot quietly regress.

Each row holds the actor's id, email, and role; the action; the logical resource
and the physical table; the resource id; the request id; the route; the outcome;
and the before and after snapshots. Rows are written when the response finishes,
not when the request arrives, so a request refused by validation is not recorded
as a change. Failures are recorded with outcome `FAILED`.

**Refusals are audited.** Every denial from the role, permission, or scope
middleware writes an `ACCESS_DENIED` row with the reason and the permissions that
were required, before the 403 is returned. A denial is more interesting to a
security review than a success, and an audit trail that only records what worked
is close to useless for one.

**Reading the audit trail is itself audited**, as is a dataset export and a
document read.

### IP addresses

An IP is personal data, so it is not collected by default. The audit policy marks
each action, and the IP is recorded only where it supports a genuine
investigation:

| Recorded | Not recorded |
|---|---|
| Login success and failure, logout | Project create and update |
| Access denied | Milestone create and update |
| User create, update, deactivate | Prediction create |
| Project delete | Recommendation generate |
| Document create and read | Alert acknowledge and status change |
| Analytics export, audit log read | Alert evaluation for one project |

The address comes from Express's `request.ip`, which honours the configured
`TRUST_PROXY` setting. That defaults to `loopback`, meaning nothing upstream is
believed until the proxy chain is declared, so a spoofed `x-forwarded-for` from
an untrusted hop is never recorded as fact.

### Before and after values

Updates, deletes, deactivations, and acknowledgements capture the row before the
change, so an audit row shows what was replaced rather than only what it became.
Creates capture only the result, since there is no prior state.

Snapshots pass through a redactor with no database or framework dependencies.
Keys such as `password`, `passwordHash`, `token`, `authorization`, `apiKey`, and
`jwt` are replaced at any nesting depth, matched without regard to casing.
Payloads over 16 KB are stored as a truncation marker with a short preview,
recursion stops at six levels, arrays are capped at 100 items, and a cyclic
object is handled rather than throwing.

An audit write never fails a request. A write that errors is logged for the
operator and the request continues. Losing one row is bad; refusing a legitimate
action because the audit table is unavailable is worse.

## 6. Endpoints

```http
POST   /api/v1/auth/login          Public. Returns the token, role, scope, and permissions
POST   /api/v1/auth/logout         Audited
GET    /api/v1/auth/me             The caller's own role, scope, and permissions
GET    /api/v1/authz/permissions   The full role-to-permission matrix
GET    /api/v1/users               Accounts within scope
POST   /api/v1/users               Create, at or below the caller's own role
PATCH  /api/v1/users/{id}          Update within scope
POST   /api/v1/users/{id}/deactivate
GET    /api/v1/users/roles         Roles the caller may assign
GET    /api/v1/analytics/export    Scoped export, audited with the caller IP
GET    /api/v1/audit-logs          Filter by action, resource, outcome, actor, resource id
```

`GET /auth/me` is what the frontend guards read. When it is reachable, its
permission list takes precedence over the frontend's mirrored table.

## 7. Frontend

Route guards live in `frontend/src/auth/`. Each route declares the permission its
page needs, the navigation is filtered to what the role can use, and a `Can`
component hides individual controls. An access-denied page names the missing
permission rather than pretending the page does not exist, so a person can ask
their administrator for the right thing.

`frontend/src/auth/permissions.ts` mirrors the backend catalogue. It is a
usability aid and says so in its own header. Keep it in step with
`src/authz/permissions.ts`; the live matrix is always available from
`GET /api/v1/authz/permissions`.

Without an API session the provider falls back to a clearly-labelled simulated
session, and `/access` offers a role switcher so the guards can be exercised in
the demo environment. The switcher changes only what the browser renders. It
cannot change what the server returns.

## 8. Migration and seeding

The role enum changed: `ADMIN`, `DEPARTMENT_OFFICER`, `EXECUTIVE_VIEWER`, and
`AUDITOR` are gone, replaced by `SUPER_ADMIN`, `PROJECT_OFFICER`, `ANALYST`, and
`VIEWER`. Existing rows need mapping as part of the migration; the natural
mapping is ADMIN to SUPER_ADMIN, DEPARTMENT_OFFICER to PROJECT_OFFICER,
EXECUTIVE_VIEWER to VIEWER, and AUDITOR to STATE_ADMIN or SUPER_ADMIN depending
on the breadth that account needs.

Other schema changes:

- `users` gains `department`, and `state_code` and `district_code` widen to 120
  characters to match the project columns they are compared against.
- `audit_logs` gains `actor_email`, `actor_role`, `resource`, `route`,
  `ip_address`, `outcome`, and `reason`, plus indexes on actor, resource, and
  outcome.
- A new `AuditOutcome` enum.

Run `npm run prisma:migrate`. The seed creates one account per role with distinct
scopes, from `DEMO_ADMIN_PASSWORD`, which is what makes the role and scope
behaviour exercisable end to end.

## 9. Tests

`test/authz.test.ts` covers the catalogue's integrity, the strict nesting of the
officer roles, the least-privilege choices above, fail-closed scope resolution,
scope filters and validation at every level, case-insensitive comparison, denial
messages that do not leak row attributes, audit scoping, and the escalation
guard. Two of its tests read the router itself and fail if a mutating route
declares no permission or no audit action, or if a route names a permission that
is not in the catalogue.

`test/audit.test.ts` covers redaction at depth, in arrays and whatever the
casing, size and depth caps, cycles, IP normalization, and the audit policy's own
consistency.

```bash
cd backend && npm test
```

Both suites test pure logic. The middleware wiring, the audit writes, and the
scoped queries need a live database to exercise and are not covered here.
