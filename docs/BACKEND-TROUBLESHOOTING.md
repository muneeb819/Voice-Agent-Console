# Backend Troubleshooting Runbook

**Applies to:** `elite-2.35` and later. Companion to [`security/BACKEND-AUDIT-2026-11-09.md`](./security/BACKEND-AUDIT-2026-11-09.md).

Every entry below maps a **real** response code or log line emitted by this codebase to its cause and fix. Codes are defined in `src/server.ts`, `src/auth-guard.ts` and `src/user-store.ts`; nothing here is speculative.

## 1. Start with the probes

```bash
curl -s localhost:3000/health/live    # process is up
curl -s localhost:3000/health/ready   # persisted state is readable
curl -s localhost:3000/api/auth/status
```

- `/health/live` → `{"ok":true,"status":"live"}`. If this fails, the process is not running or the port is wrong — check the startup log, not the application logic.
- `/health/ready` → `503` with `reason: "application_state_unavailable"` means the SQLite/JSON state could not be read or is malformed. It deliberately does **not** expose paths or DB errors. Check `VAC_DATA_DIR` permissions and disk space. Upstream provider outages intentionally do **not** fail readiness, so a restart loop is never triggered by a provider outage.
- `/api/auth/status` tells you `authEnabled`, `apiAuthEnforced`, `hasUsers`, `adminPasswordConfigured`, `authenticated` and `signupOpen`. Most "I can't get in" reports are answered by this one call.

## 2. Authentication and access

| Symptom / code | Cause | Fix |
| --- | --- | --- |
| `401 AUTH_REQUIRED` on every API call | No valid session cookie or bearer credential | Sign in at `/login`. Machine clients must send `Authorization: Bearer <token>`; query-string credentials are deliberately ignored. |
| `401 INVALID_CREDENTIALS` | Wrong email/password, **or the account is disabled** | Both cases return the same error on purpose. An owner can check `GET /api/users` for `active:false`. |
| `400 ADMIN_PASSWORD_NOT_CONFIGURED` | Admin-password sign-in used while `ADMIN_PASSWORD` is empty in server `.env` | Sign in with an email account, or set `ADMIN_PASSWORD` in `.env` and restart. |
| `403 FORBIDDEN` on `/api/secrets`, `/api/users`, `/api/state/reset`, release bundle, deploy script, provider verify, call hangup/transfer | The account role is not `owner`/`admin` | Have an owner promote the account via `POST /api/users/:id/role`. Path case and trailing slashes do **not** bypass this. |
| `403 FORBIDDEN` "read-only access" on any write | The account role is `viewer` | Viewers may only `GET`/`HEAD`. Change the role if write access is intended. |
| `403 SIGNUP_CLOSED` | Account creation requires a signed-in owner/admin (except first-run loopback bootstrap) | Ask an administrator to create the account. First-run bootstrap works only from a direct loopback request with a loopback `Host` and **no** forwarding headers. |
| `429 LOGIN_RATE_LIMITED` / `RATE_LIMITED` | 5 failures per IP+email in 15 min, or 30 sign-ins per IP per minute | Wait for the `Retry-After` header. Spoofing `X-Forwarded-For` does not reset it unless the proxy is explicitly trusted. Counters are **process-local** — they reset on restart and are not shared across instances. |
| `429 SIGNUP_RATE_LIMITED` | 10 failed signups per IP | Same as above; successful signup clears the bucket. |
| Logged out everywhere after a password change | Expected | Password rotation revokes all other sessions. Only the tab that performed the change stays signed in. |
| Session stopped working after an admin edited the account | Expected | Disabling an account or demoting it to `viewer`/`qa` revokes its live sessions immediately. |

### Bootstrap and proxy traps

- **Behind a reverse proxy, first-run signup is refused.** Correct: the proxy connects from loopback but carries forwarding headers, so it must not inherit the local-bootstrap exemption. Create the first account directly on the host, or configure `ADMIN_PASSWORD`.
- **Cookies missing `Secure` behind HTTPS.** `Secure` is added only when the connection is genuinely TLS or `X-Forwarded-Proto: https` arrives from an **explicitly trusted** proxy. Set `TRUST_PROXY` to your proxy's IP/CIDR (never `true` or `*` on an untrusted network).
- **`403 CROSS_SITE_REQUEST_BLOCKED`.** The browser sent `Sec-Fetch-Site: cross-site`, or `same-site` on a mutation. Call the API from the console's own origin. Embedded/cross-site framing is not a supported deployment.
- **`403` "Cross-origin API requests are not allowed."** A supplied `Origin` did not match the externally visible host/protocol. Requests with **no** `Origin` are still accepted for non-browser clients such as the Asterisk dialplan.

## 3. Account and password errors

| Symptom / code | Cause | Fix |
| --- | --- | --- |
| `400 SIGNUP_INVALID` with `field:"password"` | New password is under 15 or over 200 characters | Use a longer passphrase. Existing accounts with older, shorter passwords still sign in normally. |
| `400 PASSWORD_CHANGE_FAILED` `field:"currentPassword"` | Current password did not verify | Re-enter it. Repeated failures are throttled like sign-in. |
| `400 PASSWORD_CHANGE_FAILED` `field:"newPassword"` | Under 15 characters, or identical to the current password | Choose a different, longer passphrase. |
| `409 PASSWORD_CHANGE_FAILED` | The account was disabled or its password changed in another tab while the request was in flight | Sign in again and retry. Nothing was partially applied. |
| `403 ACCOUNT_REQUIRED` on change-password / revoke-sessions | You are using the legacy `ADMIN_PASSWORD` session, which has no account row | Change `ADMIN_PASSWORD` in server `.env`, or sign in with an email account. |
| `403 FORBIDDEN` "Only an owner can manage owner accounts" | An `admin` tried to disable/demote/revoke an owner, or grant `owner` | Ask an existing owner. Admins manage non-owner accounts only. |
| `409 ACCOUNT_UPDATE_FAILED` "last active owner" | Attempt to disable or demote the only active owner | Promote another account to `owner` first. |
| `404 ACCOUNT_UPDATE_FAILED` | Unknown user id | List accounts with `GET /api/users`. |

## 4. Request and payload errors

- **`400 INVALID_BODY`** — malformed JSON, or a field of the wrong type (for example `active` not boolean). The body parser rejects before the handler runs.
- **`413 BODY_TOO_LARGE`** — JSON body exceeded 4 MB.
- **`500 INTERNAL_ERROR`** — an unhandled failure. The client gets a generic message; the server logs only the error *class* (`[http] Unhandled request failure: <ErrorName>`), never a stack or secret. Reproduce with `VAC_DEBUG=1` to log method, path, status and duration per request.

## 5. Telephony bridge

- **Pre-call hook returns 401.** `/api/vici/register-call` and `/api/vici/precall` are unauthenticated **only** for an allow-listed peer with no forwarding headers. Add the PBX address to `BRIDGE_ALLOWED_IPS`; an empty allowlist permits loopback only. A loopback peer must also present a loopback `Host` (DNS-rebinding defense).
- **`INJECTION_REFUSED` from an AMI action.** A parameter contained CR/LF/NUL. This is the injection guard working; fix the caller, do not relax the guard.
- **Recording will not download.** Recordings are exclusive owner-only files and **symlinks are rejected**. Check ownership and that the file is a real file inside the recordings directory.
- **Occupied port.** The server fails closed rather than silently hopping to another port. Free the port or change the configured one.

## 6. Speech service (Python)

| Symptom | Cause | Fix |
| --- | --- | --- |
| `401 Invalid or missing API key` | No/incorrect `Authorization: Bearer` or `X-API-Key` | Configure `SPEECH_API_KEYS`. WebSockets also accept `?token=`. |
| `429 Rate limit exceeded` (HTTP) | Per-key token bucket exhausted | Raise `SPEECH_RATE_LIMIT_PER_MIN` or reduce request rate. |
| WebSocket closes `4401` | Key rejected, or runtime not ready (`1013`) | Check the key and wait for the `ready` log event. |
| WebSocket closes `4429` immediately | **Handshake** rate cap (`SPEECH_WS_HANDSHAKE_PER_MIN`, default 60/min) or the concurrent-socket cap (`SPEECH_MAX_WS_PER_KEY`) | Stop reconnect-storm loops; reconnect with backoff. Both are per key. |
| WebSocket closes `4429` mid-stream | Message-rate cap | Batch or throttle frames. |
| WebSocket closes `1009` | Frame exceeded the size cap (256 KB for TTS control messages) | Send smaller frames. |
| Startup refuses to run | `SPEECH_API_KEYS` empty without `SPEECH_AUTH_DISABLED`, or a non-positive limit | Set keys; `SPEECH_AUTH_DISABLED=true` is for local development only. |

## 7. Browser console

- **Redirected to `/login` in a loop.** The session cookie is not being sent — usually a `Secure` cookie over plain HTTP, or a proxy/host mismatch. Check `TRUST_PROXY` and the externally visible origin.
- **"Password & Sessions" is missing from the Account menu.** Expected for the legacy `ADMIN_PASSWORD` session and for the **GitHub Pages demo**, which is browser-only with no server account. Nothing is broken.
- **Edits disappeared after reload.** Unsaved edits are kept as a per-tab draft; the console asks before overwriting server state. Use **Save & Verify** to commit.

## 8. Reproducing the verification surface

```bash
npm ci
npm run build
CI=true npm test                                   # 17 Node suites
cd speech-service && python -m pytest -q           # 31 CPU tests
npm audit --audit-level=high
python3 tools/build-brand-assets.py --check
```

Run one suite in isolation with `CI=true node tools/run-tests.js <step>` (for example `account-lifecycle`, `security`, `backend-audit`, `static-console`).

**What these tests do not cover:** live provider calls, physical microphone/speaker audio, a real Chromium session, and real VICIdial/Asterisk calls. A green run is not a production certification — see the deployment prerequisites in the audit report.
