# Quality pass (10,100 checks)

Runs every check for real and writes `results.json`:

```
VAC_DATA_DIR=/tmp/vac-quality VAC_ENV_FILE=/tmp/vac-quality/.env ADMIN_PASSWORD='Any-Long-Test-Password-1' QA_OUT=/tmp/qa-results.json npm run test:quality
```

- `unit.ts`: every server module, plus `public/persona.js` and `public/opening.js`, with independent oracles and seeded random inputs.
- `api.ts`: a live server with sign-in on. Covers access control on every `/api` route, roles, cross-site origins, malformed bodies, path traversal, security headers, and state-save fuzzing.
- `ui.ts`: every console section at 1440, 1024 and 390 px wide. Checks for labels, button names, sideways scrolling and script errors.
- Saved-state fuzzing pads the run to exactly `QA_TARGET` checks (default 10,100).
