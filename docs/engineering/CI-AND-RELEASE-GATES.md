# CI and release gates

## Automated pull-request gate

The Product CI workflow runs on pull requests targeting `main`, pushes to
`main`, and manual dispatch. It uses the committed npm lockfile and Node.js
22.5.0, matching the minimum runtime documented by this repository.

The required verification sequence is:

1. `npm ci` — install the exact dependency graph from `package-lock.json`.
2. `npm run build` — compile the TypeScript application.
3. `npm test` — execute the repository's complete test runner.
4. `npm audit --audit-level=high` — fail the gate when npm reports high- or
   critical-severity dependency vulnerabilities.

The workflow receives read-only repository contents permission and does not
receive production credentials. Tests must use mocks, loopback fixtures, and
synthetic credentials. A live provider test must never be enabled in CI.

## Merge policy

- Do not merge while the Product CI check is failing, pending, or absent.
- Review dependency-audit findings and update the lockfile intentionally;
  do not bypass the audit merely to obtain a green check.
- Keep changes to telephony, authentication, recording, and data retention
  behind focused tests and a reviewer-approved change set.
- A green CI run proves only the commands above passed in the GitHub runner.
  It does not prove carrier interoperability, real-call audio quality,
  regulatory compliance, load capacity, disaster recovery, or production
  readiness.

## Production release gates

Before enabling outbound production traffic, separately complete:

- A clean-environment install, build, and full test run on the target runtime.
- Authentication, network exposure, secret handling, TLS, backup, restore,
  and log/recording-retention review.
- Provider contract, quota, latency, failure-mode, and cost validation.
- Isolated VICIdial/Asterisk/carrier end-to-end tests, including transfer,
  DNC suppression, disconnects, queue saturation, and failure recovery.
- Campaign-specific legal/compliance approval by qualified counsel and the
  responsible business/compliance owner.
- A monitored canary rollout with explicit rollback criteria.

No CI status is a compliance certification or authorization to place calls.
