# Authentication & Authorization Audit

**Repository:** MMA Digital Labs — Voice Agent Console  
**Audited ref:** `main` at `45cb0ef011377939705d5d7bee5765a05f070b8e`  
**Audit date:** 2026-11-08  
**Scope:** Node/Express console authentication, account/session storage, API authorization, browser token handling, origin protections, WebSocket authorization, and the companion Python speech-service API authentication.  
**Method:** Static source review of the current repository and existing security regression tests. This is not a penetration test, live deployment assessment, or certification.

## Executive result

**Status: NOT READY to treat authentication/authorization as production-complete.**

The repository has meaningful security controls: scrypt password hashes, random database-backed user session tokens, seven-day expiry, HttpOnly cookies, constant-time comparisons, admin-session revocation, API authentication middleware, same-origin checks when an Origin header is present, trusted-proxy configuration, loopback-only first-user bootstrap, and speech-service API keys with per-key rate limiting and WebSocket concurrency limits.

However, the review found authorization-model gaps and browser credential exposure that should be addressed before exposing the console to multiple real operators or the public internet. Existing tests cover several bootstrap, origin, and unauthenticated access cases, but do not establish role separation or comprehensive route-level authorization.

## Status update — 2026-11-09 (`elite-2.35`)

This document is the historical record of the `45cb0ef` review and is preserved as written below. The following findings have since been remediated; see [`BACKEND-AUDIT-2026-11-09.md`](./BACKEND-AUDIT-2026-11-09.md) for evidence:

| Finding | Status on 2026-11-09 |
| --- | --- |
| A-01 flat privileges | **Partly closed** — roles + active flag, admin-only routes, read-only viewers, owner/admin provisioning. Per-user *data* isolation still open. |
| A-02 token in JSON + localStorage | **Closed** — cookie-only browser sessions; legacy browser tokens cleared. |
| A-03 process-local throttling | **Open** — still needs a shared store for multi-instance deployments. |
| A-04 no revocation / password change | **Closed** — password change with session invalidation, revoke-all, account disable, role-change invalidation, last-owner protection. |
| A-05 eight-character minimum | **Closed** — 15-character minimum for new/changed passwords. MFA and breach screening still open. |
| A-06 no-Origin requests allowed | **Open** — Fetch Metadata added, but no CSRF token for cookie mutations. |
| A-07 SameSite=None + Partitioned | **Closed** — HTTPS cookies use `SameSite=Lax; Secure`. |
| A-08 WebSocket handshake rate | **Closed** — per-key handshake bucket plus a concurrency-slot leak fix on failed `accept()`. |

The release decision below still stands: this is not a production certification.

## Findings

### A-01 — Every authenticated account receives the same console-wide privileges
**Severity: HIGH**  
**Evidence:** `src/user-store.ts` defines users without a role, permission, tenant, or status field. `getUserBySessionToken()` returns any valid account as an authenticated user. `src/auth-guard.ts:isRequestAuthorized()` accepts any active user session for protected API routes. `src/server.ts:canCreateAccount()` permits any signed-in account to create another account.  
**Impact:** There is no distinction between owner, administrator, manager, QA, or read-only operator. A newly created account can reach the same protected API surface as the account that created it, including configuration and secrets-management operations. This is privilege expansion by design of the current model, not an isolated endpoint bug.  
**Required remediation:** Define a least-privilege role/permission model; add role and account status to persistent user records; make authorization decisions per route/action; restrict account provisioning to an explicit administrator/owner permission; add negative tests for every privileged operation. Do not simply assign the first account permanent super-admin rights without an explicit recovery/ownership policy.

### A-02 — Session bearer tokens are returned to JavaScript and persisted in localStorage
**Severity: HIGH**  
**Evidence:** `src/server.ts` includes `token` in successful signup/login JSON responses. `public/login.js:saveAuthToken()` writes the token to both sessionStorage and localStorage, and later sends it as an Authorization bearer token. The server also sets an HttpOnly cookie, so the browser has two credential paths.  
**Impact:** Any same-origin script execution flaw (including a future XSS or compromised dependency/script) can read and exfiltrate the long-lived bearer token. HttpOnly cookie protection does not protect the duplicate localStorage credential. The seven-day expiry increases the exposure window.  
**Required remediation:** Prefer cookie-only browser sessions with HttpOnly, Secure (HTTPS), and an appropriate SameSite policy; stop returning browser session secrets in JSON; remove localStorage/sessionStorage token persistence and bearer handoff for same-origin browser flows. Preserve a separate explicit machine-client authentication mechanism only where required, with scoped/revocable credentials. Add migration handling for old stored tokens and regression tests.

### A-03 — Authentication throttling is process-local and keyed by IP plus submitted email
**Severity: MEDIUM**  
**Evidence:** `src/server.ts:createApp()` stores `loginAttempts` and `signupAttempts` in in-memory Maps. Login uses `rateKey(req, email)`, so counters are split by submitted email; counters are lost on restart and are not shared across workers/instances.  
**Impact:** Distributed or multi-instance deployments can bypass the effective limit; cycling email values avoids a simple per-IP aggregate limit. The map cap is bounded, but eviction also weakens sustained throttling under load.  
**Required remediation:** Use a shared rate-limit store (e.g. Redis or a database-backed atomic counter) for multi-instance production, and enforce both per-IP and per-account/IP limits. Add progressive delay/lockout controls that avoid easy account-denial-of-service. Ensure trusted proxy configuration is correct before relying on client IP values.

### A-04 — Seven-day sessions have no user-session revocation or credential-change invalidation workflow
**Severity: MEDIUM**  
**Evidence:** User sessions are random opaque tokens stored in `user_sessions` and expire after seven days. `destroyUserSession()` removes only the current token. There is no password-change, account-disable, revoke-all-sessions, or session inventory workflow in the reviewed user store.  
**Impact:** A stolen session remains usable until expiry unless the user can present that exact token to logout or an operator manually changes database state. There is no normal recovery path for a compromised account.  
**Required remediation:** Add per-user session revocation, revoke-all, account disable, password-change invalidation, and optional shorter/idle expiry for privileged roles. Add tests proving old sessions stop authorizing immediately.

### A-05 — Password policy permits an eight-character minimum
**Severity: MEDIUM**  
**Evidence:** `src/user-store.ts:validatePassword()` accepts passwords from 8 to 200 characters. Passwords are stored with salted scrypt (64-byte output), which is a positive control.  
**Impact:** Eight characters is weak for a password-only administrative console, particularly without MFA. The source review did not find MFA or a recovery workflow.  
**Required remediation:** Set a stronger minimum appropriate to password-only access (recommend at least 15 characters), allow long passphrases, block common/compromised passwords where feasible, and introduce MFA for privileged accounts. Do not impose arbitrary composition rules as a substitute for length and breach screening.

### A-06 — Origin enforcement permits requests with no Origin header
**Severity: MEDIUM / deployment-dependent**  
**Evidence:** `src/request-origin.ts:isSameOriginRequest()` returns true when the Origin header is absent. The code comment explicitly preserves non-browser clients such as the Asterisk dialplan.  
**Impact:** Origin is not an authentication mechanism and non-browser clients can omit it. Cookie-authenticated state-changing endpoints therefore still depend on session secrecy and other protections. This is not by itself a demonstrated CSRF exploit, but origin checks alone do not provide a complete CSRF boundary.  
**Required remediation:** Keep non-browser integration compatibility explicit, but use a CSRF token or strict Fetch Metadata policy for browser cookie-authenticated mutations. Do not block telephony hooks as part of this application-only audit; maintain a distinct, authenticated machine-to-machine path for them.

### A-07 — HTTPS cookie policy uses SameSite=None and Partitioned
**Severity: LOW / compatibility and defense-in-depth**  
**Evidence:** `src/auth-guard.ts:setAuthCookie()` selects `SameSite=None; Secure; Partitioned` whenever the Express request is HTTPS; otherwise it uses `SameSite=Lax`.  
**Impact:** The HTTPS cookie is intentionally cross-site capable and relies on browser partitioning behavior. For a same-origin console, this is broader than necessary and may behave differently across browsers/proxy deployments.  
**Required remediation:** Prefer `SameSite=Lax` (or Strict if compatible) for first-party console sessions. Only use cross-site cookies if a documented embedded/cross-site product requirement exists. Always validate secure-cookie behavior behind the configured trusted proxy.

### A-08 — Speech-service WebSocket authentication does not apply the HTTP rate limiter
**Severity: MEDIUM / resource-abuse control**  
**Evidence:** `speech-service/app/auth.py:authenticate_ws()` verifies the key but does not call `check_rate()`; HTTP `require_auth()` does. WebSocket concurrency is separately limited by `ws_acquire()`.  
**Impact:** A valid API key can open multiple sequential WebSocket sessions and avoid the HTTP request token bucket; the concurrent cap limits simultaneous sockets but not connection churn or message volume.  
**Required remediation:** Add WebSocket connection/handshake rate limits and message/frame/idle limits with cleanup on disconnect. Keep the existing per-key concurrent socket cap. This belongs to speech-service application security, not SIP/carrier behavior.

## Positive controls observed

- Account passwords use random 16-byte salts and scrypt with constant-time digest comparison.
- User sessions use 32 random bytes, are persisted server-side, and expire after seven days.
- Admin-password sessions use HMAC-SHA256 signatures, timing-safe verification, expiry, and a revocation table.
- API routes are protected by authentication middleware; health and auth routes are intentionally public.
- First-account bootstrap is restricted to direct loopback requests with a loopback Host and no forwarding headers.
- Express trusts proxy headers only when explicitly configured.
- Browser requests with a supplied mismatched Origin are rejected; referrer policy is set to no-referrer.
- WebSocket upgrade authorization is present in the server implementation; speech-service WebSockets require a valid API key unless auth is explicitly disabled.
- Speech-service HTTP API keys are hashed before comparison, HTTP requests are rate-limited per key, and concurrent WebSockets are capped.
- Existing security tests cover unauthenticated API access, bootstrap spoofing/DNS-rebinding checks, and several bridge-peer boundary cases.

## Coverage gaps / tests still required

1. A route inventory with an expected permission for every protected route and WebSocket channel.
2. Owner/admin/operator/QA/read-only role matrix, including cross-account isolation.
3. Tests that an ordinary account cannot read or modify secrets, user accounts, campaign rules, release bundles, or privileged integration settings.
4. Cookie-only browser login/logout tests, including HTTPS behind a trusted reverse proxy and no token in JSON/storage.
5. Session revocation, account disable, password change, and revoke-all tests.
6. Shared rate-limit behavior across multiple app instances and IP/account key dimensions.
7. CSRF and Fetch Metadata tests for cookie-authenticated mutations, while preserving explicitly documented machine integrations.
8. WebSocket handshake rate, message-size, idle-timeout, and disconnect cleanup tests for the speech service.
9. Production configuration tests: HTTPS required, secure cookies, no default/weak admin password, API keys present, debug/docs disabled, and trusted proxy explicitly configured.

## Release decision

**Do not mark authentication/authorization as production-ready yet.** The highest-priority blockers are A-01 (no role/permission separation) and A-02 (browser bearer token exposed to JavaScript and localStorage). A-03 and A-04 should be resolved before a multi-instance or public operator deployment. A-06/A-07 need a deliberate first-party browser-session policy. Speech-service A-08 should be included in the security hardening track.

This audit did not change telephony configuration, carrier settings, SIP/RTP behavior, or live-call routing. It did not access or test production credentials, production databases, or live customer sessions.
