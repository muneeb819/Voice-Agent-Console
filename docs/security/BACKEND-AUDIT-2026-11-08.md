# Backend Audit & Rectification — 2026-11-08

> Historical record. See [`BACKEND-AUDIT-2026-11-09.md`](./BACKEND-AUDIT-2026-11-09.md) for the follow-up pass that closed findings A-04, A-05 and A-08.

**Scope:** Node/Express console backend (`src/`), companion Python speech service (`speech-service/`), persistence, telephony bridge, simulator, webhooks, and CI regression coverage.  
**Method:** full source review, local exploit probes, mocked end-to-end tests, and isolated test data. No production credentials, live carrier calls, or paid provider calls were used.  
**Result:** the verified defects below are fixed on this branch and covered by regression tests. This is not a production certification; staging deployment, TLS/proxy configuration, PBX interoperability, backup/restore, and operational monitoring still require operator verification.

## Fixed findings

### Authorization and sessions
- **Admin route bypass (HIGH, probe-proven):** Express matches routes case-insensitively and tolerates trailing slashes, but role checks compared the raw path. `/API/SECRETS` and `/api/secrets/` reached admin handlers as an operator. Authorization now canonicalizes paths before matching.
- **Privileged diagnostics:** `/api/deepgram/verify` and `/api/speech-service/status?url=…|apiKey=…` are admin-only, preventing non-admin use of stored credentials or explicit diagnostic targets.
- **First-owner race:** user count and insert now execute in one immediate SQLite transaction; concurrent first signups cannot both become owner.
- **Password hashing:** scrypt runs asynchronously with explicit fixed parameters; stored hash length no longer controls derivation cost.
- **Session storage:** user session tokens are SHA-256 hashed at rest, with legacy plaintext-token migration on successful lookup.
- **Login throttling:** added a per-IP aggregate limit alongside the per-email/IP limit.
- **Open redirect:** login `next` paths reject backslashes, control characters, protocol-relative URLs, and foreign origins on both server and browser paths.
- **CSRF defense-in-depth:** API requests with `Sec-Fetch-Site: cross-site` are rejected; same-site mutations are rejected. Existing Origin checks remain.

### HTTP and resource safety
- Async Express handlers are wrapped so rejections reach a final JSON error boundary (400/413/500) instead of hanging or leaking stacks.
- Upstream response bodies are size-bounded before buffering (webhooks, Deepgram catalog/audio, VICIdial API, speech service).
- Speech-service base URLs are validated; stored-key requests do not follow redirects.
- Webhook template interpolation no longer exposes arbitrary `process.env`; only the managed custom webhook secret is available. Simulator webhooks use persisted function destinations/headers rather than unsaved draft URLs.
- WebSocket simulator enforces payload limits, start timeout, heartbeat, message-rate limits, backpressure caps, pre-settings audio byte caps, and connection caps.
- AMI actions reject CR/LF/NUL injection and bound response buffering.
- Demo tunnel downloads enforce HTTPS host allowlist, timeout, size cap, and listener cleanup.
- HTTP server request/header/keep-alive timeouts and graceful SIGTERM/SIGINT shutdown are configured. Occupied ports fail closed instead of hopping.

### Persistence and recordings
- Console saves read the previous revision and write under the same immediate transaction, preventing lost updates across processes.
- JSON mirror writes use unique temp files and do not report SQLite success as mirror success.
- State normalization tolerates malformed/null entries, deduplicates IDs, repairs dangling campaign references, and bounds numeric settings.
- Bridge recordings use exclusive owner-only files, reject symlinked directories/files, and retention deletes orphaned audio.
- CSV export neutralizes spreadsheet formula prefixes.

### Telephony bridge
- SIP INVITE handling is exception-contained; SDP media endpoints must be numeric IPs in the trusted peer allowlist; RTP packets are accepted only from the negotiated peer; duplicate INVITE and bind-error races are handled.
- Capacity is keyed by stable campaign ID, not mutable names.
- Transfer completion is awaited before a competing HANGUP; fallback disposition is only reported as applied when VICIdial accepts it.
- Function execution respects enabled agent function IDs and reports failed results honestly.
- Pre-call registry is capped and swept; bridge shutdown closes monitors and awaits active session finalization.

### Python speech service
- SQLite job-store connections are closed; job deletion is conditional on terminal status; queue `task_done()` is balanced.
- Blocking-to-async audio iteration uses a bounded queue and cancellable producer.
- WebSocket STT/TTS validate config types/ranges, apply message-rate and frame-size limits, and recover from synthesis errors instead of silently killing the consumer.
- Settings reject non-positive limits; request IDs are sanitized; voice metadata corruption is skipped; stock-voice HTML is escaped.
- Docker limits WebSocket frame size and concurrency.

## Verification

- `npm run build` — passed.
- `CI=true npm test` — all 13 Node suites passed, including new `backend-audit` regressions. The real Deepgram cloud test is explicitly skipped without a live key.
- `speech-service`: `python -m pytest -q` — 27 tests passed (CPU/fake engines).
- `npm audit --audit-level=high` — 0 vulnerabilities.
- CI now includes a dedicated speech-service CPU test job.

## Remaining deployment requirements

- Configure HTTPS, a correctly scoped `TRUST_PROXY`, strong credentials, and restrictive `BRIDGE_ALLOWED_IPS` before public or remote-PBX exposure.
- Shared multi-instance rate limiting, MFA, password-change/revoke-all workflows, and per-user data isolation remain product-level work (see `AUTHENTICATION-AUTHORIZATION-AUDIT.md`).
- Validate real Asterisk/VICIdial versions, codec negotiation, backup/restore, disk quotas, and provider quotas in staging. Local mocks do not prove carrier interoperability.
