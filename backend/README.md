# Land Acquisition Predictive Analytics API

## Run

```bash
cp .env.example .env
npm install
npm run prisma:generate
npm run prisma:migrate
npm run prisma:seed          # one account per role
npm run prisma:seed:demo     # 23 demonstration cases
npm run build
npm run dev
```

The demonstration dataset and how its numbers are derived are described in
[DEMO_DATASET.md](../DEMO_DATASET.md).

API base: `/api/v1`
Swagger UI: `/docs` (disabled by default; see `ENABLE_API_DOCS`)
Health: `/health`

The backend requires PostgreSQL for operational endpoints. Configure `DATABASE_URL`
and a 32-character minimum `JWT_SECRET`; secrets are never committed. Set
`ML_SERVICE_URL` to the Python prediction service to enable model-backed inference.
When it is unset, prediction responses are explicitly marked `RULE_ONLY_FALLBACK`
and use reduced confidence.

## Security

JWT authentication, role-based authorization with permission and scope gates,
Helmet, CORS allow-listing, rate limiting, Zod request validation, request IDs,
structured request logging, and audit records are enabled. `DELETE` archives
projects by setting their status to `CANCELLED`; operational records are not
physically removed.

Six roles, twenty-nine permissions, and geographic scope are documented in
[ACCESS_CONTROL.md](ACCESS_CONTROL.md), together with the audit policy. The
threat model, the review findings, and the controls a deployment must supply are
in [SECURITY.md](../SECURITY.md).

Set `TRUST_PROXY` to match the deployment's proxy chain before relying on audited
IP addresses or rate limiting; it defaults to `loopback`, which trusts nothing
upstream. The OpenAPI explorer at `/docs` is disabled unless `ENABLE_API_DOCS` is
`true`, and is refused in production regardless.
