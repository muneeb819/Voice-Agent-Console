# Backend Audit & Troubleshooting — 2026-11-09

**Repository:** MMA Digital Labs — Voice Agent Console
**Base ref:** `main` at `d85802310b2ae8e12d83a130af99a7cc055626bb` (`elite-2.34`)
**Release under audit:** `elite-2.35`
**Scope:** Node/Express console backend (`src/`), account/session lifecycle, browser account controls, and the companion Python speech service (`speech-service/`).
**Method:** full re-run of the existing verification surface, targeted source review of the authentication/authorization hot spots, local exploit-style probes against loopback servers, and new regression tests. No production credentials, live carrier calls, physical audio devices, or paid provider calls were used.

> This report supersedes nothing. `BACKEND-AUDIT-2026-11-08.md` remains the historical record of that pass. This document records what changed on 2026-11-09 and what is still open.

## Result

**The backend regression surface is clean, and two previously open audit findings are now closed in code.** This is a verified test result, not a production certification. Deployment prerequisites and the remaining product-level gaps below still apply.

## Findings closed in this pass

### A-04 — Session revocation and credential-change invalidation (was MEDIUM)
**Was:** user sessions lived for seven days with no password change, account disable, or revoke-all workflow. A stolen session stayed usable until expiry.

**Now:**
- `src/user-store.ts` adds `changeUserPassword()`, `destroyUserSessions()`, `setUserActive()`, `setUserRole()`, `listUsers()` and `countUserSessions()`.
- Password change verifies the current password, re-reads the row under an immediate write lock (so a concurrent disable/rotation is detected instead of silently overwritten), rotates the scrypt hash, and revokes every other session. The acting tab keeps its session.
- Disabling an account revokes its sessions immediately; the account can no longer sign in, and existing tokens stop authorizing on the next request.
- Demotion to `viewer`/`qa` drops live sessions so cached privileges cannot outlive the role change.
- The last active owner can be neither disabled nor demoted, so the console cannot be locked out of its own administration.
- **Owner boundary:** an `admin` may manage non-owner accounts but cannot disable, demote, revoke the sessions of, or grant `owner` to any account. Only an owner (or the legacy `ADMIN_PASSWORD` recovery session) can do that, so admin cannot escalate itself into ownership.
- New routes: `POST /api/auth/change-password`, `POST /api/auth/revoke-sessions`, `GET /api/auth/sessions`, `GET /api/users`, `POST /api/users/:id/status`, `POST /api/users/:id/role`, `POST /api/users/:id/revoke-sessions`. Account routes are registered **after** `apiAuthMiddleware` and are additionally listed in its `adminOnly` set; `/api/auth/*` handlers re-resolve the account from the session themselves. No client-supplied identifier can act on another account's own password or sessions.
- UI: **Account → Password & Sessions** in the console rail (current password, new password, sign-out-other-devices). The control is hidden for the legacy `ADMIN_PASSWORD` session and for the browser-only static demo, where there is no server account to manage.

**Regression coverage:** `tests/account-lifecycle-verify.ts` (new `account-lifecycle` suite, 6 groups) and the server-mode block of `tests/static-console-verify.ts`.

### A-05 — Eight-character password minimum (was MEDIUM)
**Was:** `validatePassword()` accepted 8–200 characters for a password-only administrative console.

**Now:** the minimum is 15 characters, with no composition rules; long passphrases remain allowed up to 200. Server validation, the sign-up form (`minlength`, hint, strength meter) and the password-change dialog all enforce the same floor. **Existing shorter hashes keep working** — the policy gates new and changed passwords rather than locking out already-provisioned accounts. MFA and breach screening are still not implemented (see open gaps).

### A-08 — Speech-service WebSocket connection churn (was MEDIUM)
**Was:** `authenticate_ws()` verified the key but applied no handshake rate limit. Message-rate tokens (`check_ws_rate`) and the concurrent-socket cap existed, but a client could open and instantly close sockets without ever sending a frame.

**Now:**
- `Authenticator.check_ws_handshake()` adds a per-key token bucket, configurable via `SPEECH_WS_HANDSHAKE_PER_MIN` (default 60, validated positive). `_open()` applies it before acquiring a concurrency slot and closes with `4429`.
- **Slot leak fixed:** if `ws.accept()` raised after `ws_acquire()` (client vanished mid-handshake), the concurrency slot was never returned. Repeated failures would eventually lock a valid key out at `max_ws_per_key`. The slot is now released on accept failure.

**Regression coverage:** four new tests in `speech-service/tests/test_backend_audit.py` — churn cap, per-key isolation, slot release on disconnect, slot release on failed handshake, and settings validation.

## Corrections to the earlier audit record

Two findings in `AUTHENTICATION-AUTHORIZATION-AUDIT.md` (audited at `45cb0ef`) were already remediated before this pass; that document has been annotated rather than rewritten:

- **A-01 (flat privileges):** roles (`owner`/`admin`/`operator`/`qa`/`viewer`) and an `active` flag now exist, privileged routes are admin-only, viewers are read-only, and account provisioning requires owner/admin. Per-user *data* isolation is still absent — see open gaps.
- **A-02 (bearer token in JSON + localStorage):** browser login/signup are cookie-only; no session token is returned in JSON, and legacy `vac_auth_token` entries are cleared on console load. Covered by `tests/static-site-verify.ts`.
- **A-07 (SameSite=None + Partitioned):** HTTPS cookies now use `SameSite=Lax; Secure`.

## Verification (all run locally on 2026-11-09)

| Check | Result |
| --- | --- |
| `npm ci` + `npm run build` (`tsc`) | passed |
| `CI=true npm test` | **17 suites passed**, including the new `account-lifecycle` suite; 1 live Deepgram cloud test explicitly skipped (no live key) |
| `speech-service`: `python -m pytest -q` | **31 passed** (was 27; +4 A-08 regressions), CPU/fake engines |
| `npm audit --audit-level=high` | 0 vulnerabilities |
| `python3 tools/build-brand-assets.py --check` | 8 transparent brand assets match source (RGBA pixel compare) |
| `npm run sync:static` + static mirror verify | passed (`public/` ↔ `docs/` byte parity, `elite-2.35` asset versions) |

Full console log: retained in the working session as `vac-audit-235.log`; CI reproduces the same surface on every push.

## Still open — not fixed by this pass

**Application/product gaps**
- **A-03:** throttling is still process-local (`Map`-based). Multi-instance deployments need a shared atomic store (Redis or DB) plus progressive lockout.
- **MFA** for privileged accounts, and compromised-password screening.
- **Per-user data isolation:** accounts share one console state. Roles gate *actions*, not *records*.
- **A-06:** requests without an `Origin` header are still accepted for non-browser integrations. Fetch Metadata blocks cross-site and same-site mutations, but there is no CSRF token for cookie-authenticated mutations.
- Idle/absolute session shortening for privileged roles (currently a flat seven days).

**Deployment prerequisites (operator responsibility)**
- HTTPS, a correctly scoped `TRUST_PROXY`, strong credentials, and restrictive `BRIDGE_ALLOWED_IPS` before any public or remote-PBX exposure.
- Staging validation against a real PBX: codecs, SIP/RTP interop, dialplan hooks, transfer/disposition behavior.
- Backup/restore drills, disk-capacity and retention monitoring, provider quota/budget limits, and operational alerting.

## Explicit limits of this audit

- Mock and JSDOM testing only: **no live provider call, no physical microphone/speaker path, no Chromium browser audit, and no real VICIdial/Asterisk call** was exercised.
- The GitHub Pages demo is browser-only; server account, password-change and session-revocation features are not available there and are deliberately hidden.
- No production credential, production database, or live customer session was accessed.
- Passing regression tests demonstrate the tested behaviors, not the absence of all defects.
