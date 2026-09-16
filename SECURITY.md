# Security Architecture

This document describes what the Land Acquisition Predictive Analytics platform
protects, what it protects against, and how. It also records the findings of the
review dated 16 September 2026, the residual risks that were accepted, and the
controls a deployment must supply that the code cannot.

It is written for engineers working on this codebase and for reviewers assessing
it. Related documents: [ACCESS_CONTROL.md](backend/ACCESS_CONTROL.md) for the
permission and scope model in detail, [database/SCHEMA.md](database/SCHEMA.md)
for the data model.

---

## 1. What is being protected

| Asset | Why it matters |
|---|---|
| Landowner records, objections, compensation amounts | Personal and financial data about private individuals, subject to data protection obligations |
| Case documents | Title deeds, identity proofs, and bank details attached to real people |
| Project and milestone records | Operational record of a statutory process; tampering changes the official account of what happened |
| Predictions, risk scores, alerts | Influence official decisions and the allocation of scarce officer attention |
| Audit trail | The evidence of who did what; worthless if it can be altered or is incomplete |
| Accounts and role assignments | The keys to everything above |
| Model artifacts and feature vectors | Reveal how risk is scored, which invites gaming of the inputs |

The platform is decision support. It does not make statutory decisions, and no
control here should be read as making its outputs authoritative.

## 2. Trust boundaries

```text
   Officer browser                  [ UNTRUSTED ]
        |  https, Bearer token
        v
   ---- boundary 1 -----------------------------------------
   API (Express)                    [ TRUSTED, enforcing ]
     authenticate -> scope -> permission -> validate
     -> scope on row -> audit -> handler
        |                    |
        |                    +---> model service   [ UNTRUSTED upstream ]
        v
   ---- boundary 2 -----------------------------------------
   PostgreSQL                       [ TRUSTED store ]
```

**Boundary 1 is the security boundary.** Everything in the browser is untrusted,
including the frontend this repository ships. Route guards and hidden menu items
are usability, not enforcement; they are documented as such in the code that
implements them.

**The model service is an untrusted upstream.** Its URL is operator
configuration, but a compromised or misconfigured model host must not be able to
steer the API, so its responses are schema-validated and its failures degrade to
the rule-only path.

## 3. Threat model

Each row states the threat, the control, and what remains.

### Broken authentication

Passwords are hashed with bcrypt at cost 12 and never stored, logged, or
returned; the redactor strips `password`, `passwordHash`, and similar keys at any
depth before anything reaches the audit table.

Every login failure returns the same status and the same message, and does the
same work: when no account matches, the password is still compared against a
decoy hash generated at boot from random bytes. Without that, an unknown address
returns in a fraction of the time a known one does, which is a reliable
account-enumeration oracle.

Residual: there is no second factor. For a system holding this data, one should
be added before it carries real records.

### Broken authorization

Three gates on every protected route: role, permission, then scope. Permissions
come from one catalogue, so widening a role is a change to one table rather than
a hunt through the router. Two tests read the router itself and fail if a
mutating route declares no permission or no audit action, or names a permission
that is not in the catalogue.

Scope resolution fails closed: a role whose level requires a state or district
resolves to an empty scope when that assignment is missing, matching no rows at
all.

### Insecure direct object reference

Single-row routes load the target and confirm it is inside the caller's scope
before the handler runs. Collections never reach that middleware, so **every
list, aggregate, and export applies a scope filter in its own query**: project
lists, analytics counts, risk trends, the alert queue, the notification centre,
alert history, dataset export, and the account list.

A row that exists but is out of scope answers with **404, identically to a row
that does not exist**. A 403 there would confirm the identifier is real, which is
all an attacker walking identifiers needs. The true reason is written to the
audit log, where it belongs. Identifiers are UUIDs, so they are not guessable in
sequence either.

### SQL injection

All database access goes through Prisma with parameterized queries. There is no
`$queryRaw`, no `$executeRaw`, and no string-built SQL anywhere in the codebase;
a grep for raw query APIs returns nothing. Search filters use Prisma's `contains`
operator, not interpolation.

### Cross-site scripting

React escapes interpolated values by default, and the codebase contains no
`dangerouslySetInnerHTML`, no `innerHTML`, and no `document.write`. The built
frontend carries a content security policy with `default-src 'none'` and
`script-src 'self'`, injected at build time so the development server's inline
hot-reload scripts do not force the policy to be relaxed. The API sends its own
policy of `default-src 'none'` with sandbox, since it serves no markup.

Stored values cannot carry control characters or terminal escape sequences:
`safeText` rejects them at the boundary, and geographic identifiers are further
restricted to letters, marks, digits, and a short punctuation set.

### Cross-site request forgery

The API authenticates with a Bearer token in the Authorization header and never
with a cookie. A browser does not attach an Authorization header to a cross-site
request on its own, so classic CSRF does not apply. The client sets
`credentials: 'omit'` explicitly so ambient credentials cannot be reintroduced by
accident, and the API refuses a request body that is not `application/json`,
which blocks the simple form post a cross-site page could otherwise make.

If cookie authentication is ever introduced, `SameSite=Strict`, `HttpOnly`,
`Secure`, and an anti-CSRF token all become mandatory. This is stated in the
security middleware so the next person to touch it sees it.

### Server-side request forgery

There is one outbound request in the system: the model service call. Its URL is
operator configuration rather than user input, so it is not a classic SSRF sink,
but it is hardened anyway. The scheme is pinned to http or https, redirects are
refused outright, the response is bounded in both time and size, and the body is
schema-validated before any of it reaches a client.

Refusing redirects is the control that matters most: a redirect from the model
host could point at a cloud metadata endpoint, and there is no legitimate reason
to follow one.

### Insecure file uploads and malicious documents

**There is no binary upload endpoint.** The platform stores document metadata
only. That metadata is nonetheless constrained: document types are an
allow-list rather than free text, `storageKey` must be an object-store key with
no traversal, no absolute path, no backslash, and no URI scheme, and a stored
object must arrive with a SHA-256 digest, because an object without one cannot be
shown to be the object that was reviewed.

`storageKey` is never returned by the API. Knowing it is a step towards reaching
the object outside this API's authorization.

Before an upload endpoint is added, all of the following are required:

1. Size cap enforced before the body is buffered.
2. Content type from magic-byte sniffing, not from the client's header or the
   file extension, checked against an allow-list.
3. Anti-malware scan before the object is marked available.
4. Server-generated storage key; never a client-supplied path.
5. Storage in a separate bucket on a separate origin, not on the API origin.
6. Download through short-lived signed URLs, with `Content-Disposition:
   attachment` and `X-Content-Type-Options: nosniff`.
7. Digest recorded at write and verified at read.
8. Office and PDF documents treated as active content: never rendered inline on
   an origin that holds a session.

### API abuse and rate limiting

Four tiers, all keyed on `request.ip`, which honours the configured
`TRUST_PROXY` setting so a spoofed forwarded header cannot reset someone else's
bucket.

| Tier | Limit | Applies to |
|---|---|---|
| General | 120 per minute | Every route |
| Authentication | 10 per 15 minutes, successes not counted | Login |
| Expensive | 10 per minute | Prediction, recommendation generation, alert evaluation, account creation |
| Export | 5 per hour | Bulk dataset export |

Pagination is capped at 100 rows, supplied snapshot arrays are capped, request
bodies at 1 MB, and every numeric input has an upper bound, so a single request
cannot be used to drain a table or exhaust memory.

### Brute force

Per-address limiting alone does not stop a distributed attack on one account, so
failures are also counted per account: five consecutive failures lock it for
fifteen minutes, and the counter resets on success. The response during a lockout
is identical to any other failure.

Residual: a known address can be locked deliberately, which is a denial of
service against one person. The lockout is time-bounded and the per-address limit
catches the attacker, which is the usual trade. An operator can clear a lock by
setting `locked_until` to null.

### Privilege escalation

Roles are ranked. An administrator may only assign a role at or below their own,
may not edit an account that outranks them, and may not move an account outside
their own scope. Deactivating your own account is refused.

The review found and fixed a second escalation path: **project update could
relocate a project between districts.** The scope middleware validates the row as
it currently stands, which proves the caller may touch it but says nothing about
where the request body is trying to move it. Both checks now run on update.

### Data leakage

Responses name their fields rather than returning whole rows, so a future column
is not published by default. Specifically removed during this review:

- The stored feature vector (`inputSnapshot`) is no longer returned by any
  endpoint. It is the model's exact input, kept for reproducibility and audit.
- `storageKey` is no longer returned for documents.

Aggregates are scope-filtered before the database answers, because a count over
out-of-scope rows leaks the same information as the rows themselves. Error
responses carry a code and a curated message; a 5xx carries no details at all,
and the 404 handler no longer echoes the requested path.

### Exposed environment variables and secrets

No secret is committed. A `.gitignore` now covers `.env`, key material, and model
artifacts; before this review there was none, so a developer's `.env` would have
been committed on the first `git add`.

Configuration is validated at boot and the process refuses to start on a missing
`DATABASE_URL`, a `JWT_SECRET` under 32 characters, a wildcard `CORS_ORIGIN`, or
a non-http model service URL. No endpoint echoes configuration. The OpenAPI
explorer, which documents the whole attack surface, is off unless a deployment
opts in and is refused in production regardless.

### Insecure JWT handling

Verification pins the algorithm to HS256 and checks issuer and audience. Without
an algorithm pin a library verifies whatever the token's own header requests,
which is how algorithm-confusion attacks work: the attacker picks the algorithm,
not the server. Tokens carry a unique `jti` so a denylist has something to key
on, expire in 15 minutes, and every verification failure returns one message, so
"expired" cannot be told from "forged".

Residual: tokens are stateless, so logout records intent rather than revoking
anything and a stolen token is valid until it expires. The compensating controls
are the short lifetime and the audit trail. Rotating `JWT_SECRET` invalidates
every token at once and is the emergency control. A `jti` denylist in Redis is
the right next step if the window needs to be shorter.

The frontend holds the token in `localStorage`, which is reachable by any script
that achieves execution on the origin. The mitigations are the content security
policy, React's escaping, and the short lifetime. The alternative, an `HttpOnly`
cookie, trades XSS exposure for CSRF exposure and requires the full set of cookie
controls; that trade is available but has not been made.

### Excessive permissions

Six roles, twenty-nine permissions, least privilege throughout. Viewer holds six
read permissions and no access to case documents, because those hold landowner
personal records. Analyst holds no operational write beyond creating a
prediction. Audit read stops at the two administrator roles, and audit export at
the super administrator alone. The four officer roles nest strictly, and a test
asserts the containment so a later edit cannot give a narrower role something a
wider one lacks.

### Sensitive logs

Log lines are assembled from named fields rather than by spreading objects,
because spreading is how request bodies and tokens reach a log aggregator that
has a wider audience than the database. No request bodies, no response bodies,
and no query values are logged; the request log records method, path, status, and
duration. Control characters are stripped so a log line cannot be forged or
split. Stack traces appear outside production only.

The review found the notification service logging full alert descriptions and
recipient identifiers, which describe a real case. It now logs identifiers and
severity only.

### Insecure CORS

The allow-list is explicit and validated at boot. A wildcard is refused because
this API sends credentials; plain http is refused outside localhost; an origin
carrying a path is refused because it would widen the match. Methods and headers
are pinned rather than reflected.

### Dependency vulnerabilities

Both packages report zero advisories. The review found one high-severity finding:
Prisma pinned a vulnerable `deepmerge-ts` (GHSA-ggr8-5vv4-36mx, stack exhaustion
on recursive object graphs). The advisory's own suggested fix downgrades Prisma;
instead an npm override pins the fixed `deepmerge-ts` 8.0.2, which resolves the
advisory with Prisma left current and generation verified.

`npm audit` should run in CI on both packages and fail the build on a high or
critical finding.

### Input validation

Every route validates params, query, and body before a handler runs. Bodies are
**strict**: an unexpected field is refused rather than silently dropped, because
silent stripping hides a client bug and hides an attacker probing for a field the
server might accept. Text is length-bounded and rejects control characters; every
number has an upper bound; every enumeration is an allow-list; dates are
cross-checked where one must not precede another.

The review found the geographic identifier pattern rejecting ordinary Indic place
names, because Indic scripts write vowels as combining marks and the pattern
allowed only letters and digits. This was a correctness bug in a security
control, and it is the kind that gets a control disabled in production. Fixed by
admitting `\p{M}`.

## 4. Findings from this review

| Severity | Finding | Status |
|---|---|---|
| High | Project update could relocate a project into or out of the caller's district, escaping scope | Fixed: body scope check added on update |
| High | Vulnerable `deepmerge-ts` reachable through Prisma | Fixed: npm override to 8.0.2, zero advisories |
| Medium | Stored model feature vector returned by prediction, project detail, and high-risk endpoints | Fixed: excluded from every response |
| Medium | Out-of-scope rows answered 403, confirming the identifier was real | Fixed: uniform 404 |
| Medium | No brute-force control on login beyond a 120/minute global limit | Fixed: 10 per 15 minutes plus per-account lockout |
| Medium | Login timing revealed whether an account existed | Fixed: decoy hash comparison |
| Medium | OpenAPI explorer served publicly with no authentication | Fixed: opt-in, refused in production |
| Medium | JWT verification did not pin algorithm, issuer, or audience | Fixed |
| Medium | No `.gitignore`, so a developer `.env` would be committed | Fixed |
| Medium | Model service response passed to clients unvalidated; network failure surfaced as a 500 | Fixed: schema-validated, size- and time-bounded, redirects refused, degrades to rule-only |
| Low | Document `storageKey` returned to any reader | Fixed: excluded from responses |
| Low | Notification logging included case descriptions and recipient identifiers | Fixed: identifiers and severity only |
| Low | 404 handler reflected the requested path into the response | Fixed |
| Low | Request logger spread arbitrary objects into log lines | Fixed: named fields, sanitized |
| Low | Document type and reference were unbounded free text; no digest required with a stored object | Fixed: allow-list, bounded text, digest required |
| Low | Bodies stripped unknown fields silently | Fixed: strict bodies |
| Low | Geographic identifier pattern rejected Indic place names | Fixed |

## 5. What the deployment must supply

The code cannot provide these.

- **TLS termination**, with HTTP redirected to HTTPS. The API sets HSTS, which is
  meaningless without it.
- **Security headers on the static frontend.** A meta tag cannot express
  `frame-ancestors` and cannot carry HSTS. The host should send
  `Content-Security-Policy` with `connect-src` narrowed to the exact API origin,
  `frame-ancestors 'none'`, `Strict-Transport-Security`,
  `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`.
- **`TRUST_PROXY` matching the real proxy chain.** Audited IP addresses and
  rate-limit buckets are only trustworthy once it is set correctly.
- **A least-privilege database role.** The application needs DML on its own
  schema, not DDL and not superuser.
- **Secret management.** `JWT_SECRET` from a cryptographic source, unique per
  environment, held in a secret manager rather than a file, with a rotation
  procedure. Rotation invalidates every issued token, which is intended.
- **Backups of the audit trail**, retained independently of the application
  database, so an attacker with database access cannot erase the record.
- **Log shipping with access control.** Logs are redacted, but they still name
  projects, routes, and actors.
- **`npm audit` in CI**, failing on high or critical.

## 6. Accepted residual risks

1. **No multi-factor authentication.** Should be added before real records.
2. **Tokens cannot be revoked before expiry.** Fifteen-minute lifetime and the
   audit trail are the compensating controls; secret rotation is the emergency one.
3. **Token in `localStorage`.** Traded against CSRF exposure; the content
   security policy is the mitigation.
4. **Account lockout enables targeted denial of service.** Time-bounded and
   operator-clearable.
5. **No field-level encryption.** Personal data is protected by transport
   encryption, database access control, and application authorization, not by
   encryption at the column level.
6. **Audit rows are append-only by convention, not by database grant.** A
   least-privilege role without UPDATE or DELETE on `audit_logs` would enforce it.
7. **Middleware and persistence are not covered by automated tests.** The three
   suites test pure logic: the permission catalogue, scope resolution, input
   validation, and redaction. The wiring that applies them needs a live database
   and an HTTP harness to exercise.

## 7. Verification

```bash
cd backend && npm audit && npm test
cd frontend && npm audit && npm run build
```

143 tests across three suites cover the permission catalogue and its strict role
nesting, fail-closed scope resolution, scope validation including body-based
relocation, the CORS allow-list rules, input validation including traversal,
control characters, digests, document types, and password rules, audit redaction
at depth and under cycles, and the audit policy's own consistency. Two of them
read the router and fail if a mutating route is missing a permission or an audit
action.

## 8. Reporting a vulnerability

Report privately to the platform security contact for the deploying authority.
Do not open a public issue. Include the request, the response, and the
`x-request-id` header, which correlates to the audit trail.

Please do not test against a production deployment. Every refusal is recorded as
an `ACCESS_DENIED` audit row, and an officer will be investigating it.
