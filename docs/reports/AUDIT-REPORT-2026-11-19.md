# Final Audit, Remediation & AWS EC2 Deployment Report

- **Project:** Voice Agent Console (`muneeb819/Voice-Agent-Console`)
- **Audit date:** 2026-11-19
- **Branch audited:** `arena/600a80f3-voice-agent-console` (base `204e5a0`, merged with `origin/main` `7acd3ca` / PR #47, remediated at `a6f933e`)
- **Runtime:** Node.js 22.5+ / TypeScript / Express 4 / `node:sqlite` (optional `better-sqlite3`)
- **Target:** single-tenant AWS EC2 instance behind an nginx TLS reverse proxy
- **Companion findings sheet:** [`AUDIT-FINDINGS-2026-11-19.csv`](./AUDIT-FINDINGS-2026-11-19.csv)

---

## 1. Executive verdict

**Code-side release gate: PASS on the re-audited merge state.** This revision re-runs the audit after merging `origin/main` (`7acd3ca`, including PR #47's three-mode VICIdial SIP connector) into the audit branch, then hardening and retesting that connector.

- `npm ci` completed (128 packages) in a clean `node_modules/`.
- `npm run build` completed with **0 TypeScript errors** under `strict`, `noUnusedLocals` and `noUnusedParameters`; the rebuilt `dist/` contains `dist/vici-sip-registration.js` and the bridge import.
- `npm test` completed with **exit 0**: **18 suites, 120 reported ✓ checks**, one intentional live-Deepgram test skipped because no provider key was supplied. The new `sip-registration` suite contributes 7 of those checks.
- `npm audit --audit-level=high` reported **0 vulnerabilities**.
- The separate Python speech service passed **31/31 pytest** tests.
- A real rebuilt `dist/server.js` process was started and exercised on `127.0.0.1:5544`: `/api/health` 200, `/login` 200, `/` 302 to login, `/api/ready` 302 with auth disabled, and the bridge listeners started on the expected loopback ports.
- `bash -n` passed for `deploy/aws-deploy.sh` and `deploy/vicibox-install.sh`; `git diff --check` is clean.

**Deployment verdict: READY FOR EC2 on the remediated branch commit (`a6f933e`), not on unaudited `main`.** The branch now includes current `main`, so the SIP connector, the previous audit fixes and the rebuilt `dist/` are tested together. `main` itself still lacks this hardening until the branch is pushed, reviewed and merged. The four environment-specific paths that cannot be executed here remain limitations: a real `docker build`, the `deploy/aws-deploy.sh`/systemd/nginx sequence on EC2, a live Deepgram call, and a live VICIdial/PBX call including a real SIP REGISTER to a registrar. Those are test-environment limits, not code failures.

**Findings recorded:** 60. **Fixed:** 37. **Open:** 12. **Accepted risk:** 5. **Verification limitations:** 4. **Passed evidence:** 2.

| Severity | Count | Fixed | Remaining |
|---|---:|---:|---|
| Critical | 2 | 2 | 0 |
| High | 10 | 9 | 1 open repository-state finding (GIT-01: branch still unpushed, no PR) |
| Medium | 18 | 12 | 6 (4 open, 2 accepted) |
| Low | 24 | 14 | 10 (7 open, 3 accepted) |
| Info / verification | 6 | — | 4 limitations + 2 passed |

No Critical or High **code** finding remains unfixed, including in the newly merged SIP connector. One High **repository-state** finding remains: the work is committed locally but not pushed and has no pull request. See §10 and §11.

---

## 2. How the system actually works

The console is a single-tenant control plane for a Deepgram Voice Agent plus a VICIdial/Asterisk bridge.

```
Browser (public/index.html + app.js)
   │  same-origin HTTP + WebSocket, session cookie
   ▼
Express server (src/server.ts, default 127.0.0.1:533)
   ├─ /api/state, /api/auth/*, /api/keys, /api/providers/*, /api/tts/*
   ├─ /ws/simulator  → live-simulator.ts → Deepgram Agent WS
   ├─ /ws/vici-monitor → bridge telemetry
   ├─ SQLite (data/console.sqlite) + data/console-state.json mirror
   ├─ data/recordings and data/simulator-recordings (WAV/WebM)
   └─ vici-bridge.ts
        ├─ AudioSocket TCP :9092
        └─ SIP/RTP UDP :5062 ↔ VICIdial/Asterisk
             └─ vici-client.ts → VICIdial non-agent/agent API
             └─ ami-client.ts  → Asterisk AMI (transfer/hangup fallback)
```

Configuration flows through explicit **Save & Verify**: the browser edits agents, campaigns, providers and functions, validates them server-side, then persists a normalized state. The bridge resolves the campaign and bot, composes the opening, streams audio to/from Asterisk, executes model function calls, writes a CDR, and optionally records a stereo 8 kHz WAV.

Deployment topology expected by the project:

```
browser ──TLS──> nginx :533 (0.0.0.0) ──HTTP──> Node 127.0.0.1:534
```

`HOST=127.0.0.1`, `PORT=534`, `TRUST_PROXY=127.0.0.1`; only nginx is exposed. `deploy/aws-deploy.sh` builds this layout and `deploy/voice-agent-bridge.service` covers the co-located ViciBox variant.

---

## 3. What was deeply audited

- All 29 TypeScript modules (≈12.4k lines), including `db.ts`, `defaults.ts`, `settings-builder.ts`, `vici-client.ts`, `vici-loopback-tester.ts`, `simulator-recordings.ts`, `ami-client.ts` and the new `vici-sip-registration.ts`.
- The 18 test suites, their fixtures, offline-fetch policy, temp data directories and SQLite fallback, plus the new mock-registrar `sip-registration` suite.
- `public/` and the `docs/` GitHub Pages mirror: HTML structure, event binding, `innerHTML`/`esc()` usage, asset versions, service worker/cache assumptions and static-login behavior.
- Every root script, `deploy/*`, `ops/*`, `.vscode/*`, `.gitignore`, `.dockerignore`, `Dockerfile`, `render.yaml`, `vercel.json`, `package.json`, `tsconfig.json` and `tools/release-manifest.json`.
- The Python speech service Dockerfiles, compose profiles, requirements split and 31-test fake-runtime suite.
- Git history/status for generated artifacts, mixed states, stale docs and private data.

Not treated as findings: cosmetic `html-validate` preferences (`void-style`, `no-inline-style`, long `<title>`) that do not change behavior. Real structural and accessibility errors were fixed.

---

## 4. Critical and High findings fixed

### 4.1 Critical — provider placeholders could exfiltrate the admin password and PBX secrets

The old interpolation helper accepted **every** value in `MANAGED_SECRET_KEYS`. An operator who could edit a provider prompt, endpoint, key or header could write `{{ADMIN_PASSWORD}}`, `{{VICI_API_PASS}}` or `{{AMI_SECRET}}` and have the server substitute the real secret into an outbound provider request.

**Fix:** `src/env-store.ts` now exposes `interpolateProviderPlaceholders`, restricted to provider credentials, the speech-service URL/key and non-secret routing values. `ADMIN_PASSWORD`, `VICI_API_PASS`, `AMI_SECRET` and `CUSTOM_WEBHOOK_SECRET` are never resolvable there. `live-simulator.ts` and `vici-bridge.ts` use only the new helper. A regression in `tests/backend-audit-verify.ts` proves the admin/PBX values stay out while provider values still resolve.

### 4.2 Critical — the Docker image could never bind its own port

`Dockerfile` ran as UID 1000 but set `PORT=533`. Linux reserves ports below 1024, so the shipped container exited with `EACCES`.

**Fix:** the image now listens on **8080**, declares `EXPOSE 8080`, sets `VAC_DATA_DIR=/data`, creates and owns `/data/recordings`, declares `VOLUME ["/data"]`, adds a `/health/live` `HEALTHCHECK`, and prunes dev dependencies after the build. `README.md` now shows the working `-p 533:8080` + `-v voice-agent-data:/data` command. **Docker itself is not installed in this sandbox, so this remains a static review; run one `docker build` on EC2 before relying on the container path.**

### 4.3 High — partial secret disclosure

`maskSecret` returned `abcd••••wxyz`, including the first/last four characters of `ADMIN_PASSWORD`. Every viewer/operator with `/api/state` access saw those fragments. The static-demo helper in `public/app.js` did the same for browser-local secrets. Both now return a fixed `••••••••`, with no value characters. Server behavior is regression-tested; the static-console suite passes after the client change.

### 4.4 High — no browser security headers

Added to every response in `src/server.ts`:

- `Content-Security-Policy`: `default-src 'self'`; scripts/styles self + `'unsafe-inline'` (required by the current UI); Google Fonts; images/media `self data: blob:`; `connect-src 'self' https://api.deepgram.com wss://agent.deepgram.com`; `object-src 'none'`; `base-uri 'self'`; `form-action 'self'`; `frame-ancestors 'none'`.
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Permissions-Policy: microphone=(self), camera=(), geolocation=()`
- `Strict-Transport-Security` **only when `req.secure`** (so it is not sent over plain HTTP/loopback).
- `app.disable('x-powered-by')`.

Verified live on `/health/live` and `/login`; asserted in `backend-audit-verify.ts`.

### 4.5 High — login throttle collapsed all proxied users into one bucket

The throttle keyed on `req.socket.remoteAddress`, which is nginx/the ALB when `TRUST_PROXY` is correctly set. One abusive client could exhaust the shared 30/min bucket and lock out every operator. It now keys on `req.ip` after trusted-proxy resolution. Keep `TRUST_PROXY` restricted to the actual proxy address/CIDR; otherwise `req.ip` is spoofable.

### 4.6 High — systemd ran the service as root

Both generated units (`deploy/aws-deploy.sh` and `deploy/voice-agent-bridge.service`) now run as the unprivileged **`voiceagent`** account with `NoNewPrivileges`, `PrivateTmp`, `PrivateDevices`, `ProtectSystem=full`, `ProtectHome`, kernel/control-group protection, `RestrictSUIDSGID`, `LockPersonality` and `UMask=0077`. The AWS script creates/chowns the account; the ViciBox installer does the same and keeps `CAP_NET_BIND_SERVICE` for port 533. **systemd was not executable in this sandbox — validate with `systemd-analyze security voice-agent-console.service` on EC2.**

### 4.7 High — non-root default port never actually fell back

`listenWithFallback(initialPort, 0)` disabled the EACCES retry, contradicting the documented promise. It now retries once only for `EACCES` on ports `< 1024`; `EADDRINUSE` still fails fast. The chosen port is exported so generated config and logs agree. Executed live: `PORT=533` → EACCES → **5533**.

### 4.8 High — Docker healthcheck/data persistence

The old healthcheck targeted the wrong port and runtime data had no volume. Fixed with 8080 + `/health/live` + `/data` volume. Recordings, SQLite and the JSON mirror now survive container replacement when the volume is mounted.

---

## 5. Other fixes worth naming

| Area | Before | After |
|---|---|---|
| HTML structure | One extra `</div>` at `public/index.html:53`, orphaned canvas comment | Removed; `html-validate` close-order clean |
| Buttons | Six implicit-submit buttons, inline `onclick` close | `type="button"`, `aria-label`, delegated `keys-close-x` handler |
| Static portability | `.vscode` hardcoded a production IP and `F:\` path; ops script hardcoded a path | loopback/`${workspaceFolder}`/`$PSScriptRoot` |
| LAN detection | Every `172.*` address excluded, hiding EC2 VPC addresses | Skip docker/veth/lo by name; keep `172.31.x` |
| Demo latency | Metrics ports probed sequentially (~1.1 s) | Parallel, one bounded deadline |
| cloudflared download | `http`, arbitrary redirects, no size cap | HTTPS + GitHub host allowlist + 30 s timeout + 100 MiB cap |
| Type fidelity | `@types/express` v5 vs Express 4; `@types/node` v20 vs Node 22 | `@types/express@4.17`, `@types/node@22` |
| Dead code | Unused `http`, `retriesLeft`, `req` | Removed; `noUnusedLocals`/`noUnusedParameters` on |
| Generated dialplan | Hardcoded `:533` and `PORT=533` | Uses actual validated `PORT` with 533 fallback |
| Runtime state in Git | `data/console-state.json` tracked (35 KB, 5 agents) | Untracked, preserved on disk, `data/` ignored |
| Generated audit output | `audit/browser-results.json` tracked (212 KB) | Deleted + ignored |
| Stale release notes | `elite-2.19`, “42/42 + 19/19”, “100-port fallback”, hardcoded IP | `nova-3.5`, report reference, honest port behavior |
| README Docker | Root port 533, no volume, misleading Render text | Unprivileged 8080, volume, working command |
| Historical audit | Prototype-only 28% report presented as current | HISTORICAL banner + link to this report |

The VICIdial generated config now also uses the live process port, so a Docker/`PORT=8080` deployment does not generate an Asterisk `CURL(http://host:533/...)` that points at nothing.

---

## 6. Verification evidence (executed, not claimed)

| Gate | Command | Result |
|---|---|---|
| Clean install | `npm ci` | exit 0, 128 packages |
| Type check / build | `npm run build` | exit 0, 0 errors; `dist/vici-sip-registration.js` emitted |
| Full Node suite | `npm test` | exit 0, **18 suites, 120 ✓**, 1 intentional live-provider skip |
| SIP registration suite | `node tools/run-tests.js sip-registration` | exit 0, **7/7** checks |
| Dependency audit | `npm audit --audit-level=high` | `found 0 vulnerabilities` |
| Python service | `.venv/bin/python -m pytest -q` (speech-service) | **31 passed** |
| Shell syntax | `bash -n deploy/aws-deploy.sh deploy/vicibox-install.sh` | exit 0 |
| JS syntax | `node --check public/app.js tools/start-demo.js` | OK (covered by static-site suite) |
| Whitespace | `git diff --check` and `git diff --cached --check` | clean |
| Live HTTP | rebuilt `dist/server.js` on `127.0.0.1:5544` | `/api/health` 200 (1288-byte JSON); `/login` 200; `/` 302; `/api/ready` 302 with auth disabled |
| Non-root port | `PORT=533` without `E2B_SANDBOX` (prior audit run, same code path) | EACCES logged → successfully bound 5533 |
| Static mirror | `npm run sync:static` | `public/app.js` → `docs/app.js`; static-site suite passed in `npm test` |

Suite highlights: Step 1 **15/15**, Step 2 **7 passed + 1 skipped (live Deepgram)**, Step 3 **9/9**, Step 4 **13/13**, Security **7/7 groups**, SIP registration **7/7**, backend-audit, account lifecycle, health, static-site, static-console and all greeting/persona/bridge/mock-audio suites.

### What this evidence does **not** prove

1. **No Docker build/run** — Docker is unavailable in the sandbox.
2. **No real AWS/nginx/systemd execution** — no SSH/AWS credentials and no init system here.
3. **No live Deepgram call** — no provider key; the suite is offline by default.
4. **No live VICIdial/Asterisk call or live SIP REGISTER** — SIP digest, refresh, unregister and failure handling are verified against a local mock UDP registrar only; no real registrar account was contacted.
5. **No Chromium visual/mobile smoke in this session** — Playwright/Chromium is not installed and its browser CDN is outside the allowed network. jsdom/static-console tests passed; historical browser audit results are in `audit/README.md`.

These are deployment-environment tests, not code defects. Run them on the instance before placing production calls.

---

## 7. AWS EC2 deployment runbook

### 7.1 Instance and network

- Ubuntu 22.04+ or Amazon Linux 2023, **t3.small or larger** (2 GB RAM minimum; the speech service with GPU models is a separate host).
- Security group inbound: `22` from your admin IP; `533` (or `443` behind an ALB) from your operators. **Do not expose 534, 9092 or 5062.**
- Outbound: 443 for Deepgram/package downloads; SIP/RTP to the PBX only if remote.

### 7.2 Native install (recommended)

```bash
# On the EC2 instance
sudo apt-get update && sudo apt-get install -y git curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v    # must be >= 22.5

git clone https://github.com/muneeb819/Voice-Agent-Console.git
cd Voice-Agent-Console
sudo bash deploy/aws-deploy.sh --ip <YOUR_EC2_PUBLIC_IP_OR_DNS>
```

The script is re-runnable and will:

1. verify Node ≥ 22.5 and install nginx/openssl/curl;
2. copy the app to `/opt/voice-agent-console`;
3. create `.env` with a generated `ADMIN_PASSWORD` **only if missing**;
4. pin `HOST=127.0.0.1`, `PORT=534`, `TRUST_PROXY=127.0.0.1`;
5. run `npm ci --include=dev` and `npm run build`;
6. create a self-signed certificate with the correct IP/DNS SAN (or install your certificate with `--cert/--key`);
7. create `voiceagent`, install the hardened systemd unit, write the nginx TLS block, and probe `/api/health` on both hops.

Retrieve the generated bootstrap password **as root** and store it in your password manager:

```bash
sudo grep '^ADMIN_PASSWORD=' /opt/voice-agent-console/.env
```

The script intentionally does not print it to the console/logs.

### 7.3 Verify on the instance

```bash
systemctl status voice-agent-console.service
systemd-analyze security voice-agent-console.service   # optional hardening score
curl -fsS http://127.0.0.1:534/health/live
curl -fsS http://127.0.0.1:534/health/ready
curl -fsS http://127.0.0.1:534/api/health
curl -fsSk https://127.0.0.1:533/health/live
sudo nginx -t
journalctl -u voice-agent-console.service -f
```

From your workstation:

```bash
curl -kI https://<YOUR_EC2_PUBLIC_IP>:533/
```

Open the console, sign in with the bootstrap admin password, create a named **owner** account, then rotate/remove `ADMIN_PASSWORD` after owner access is confirmed. Add provider keys and PBX settings in the console (server-side storage), not in browser local storage.

### 7.4 TLS and load balancers

- The self-signed certificate is suitable for a quick internal test; browsers warn.
- For a trusted certificate, use a DNS name and ACM/Let’s Encrypt. If an ALB terminates TLS, forward to nginx or directly to Node, set `TRUST_PROXY` to the ALB/nginx CIDR, and make sure `X-Forwarded-Host` carries the **browser-visible** port (443 implicit, or `:533`).
- `--real-ip-from <ALB CIDR>` restores the real client IP so login throttling is per client. Never use `0.0.0.0/0` or `true`.

### 7.5 Docker alternative (static review only here)

```bash
docker build -t voice-agent-console .
docker run -d --name voice-agent-console \
  --network host \
  -e ADMIN_PASSWORD='replace-with-a-long-passphrase' \
  -e HOST=127.0.0.1 \
  -e PORT=8080 \
  -e TRUST_PROXY=127.0.0.1 \
  -v voice-agent-data:/data \
  voice-agent-console
```

With `--network host` on Linux, Node listens on `127.0.0.1:8080`; point nginx at that port. Keep 8080 closed in the security group. If you publish `-p 533:8080` instead, set `HOST=0.0.0.0` and give the proxy the correct Docker bridge address in `TRUST_PROXY`; do not expose 8080 directly.

### 7.6 Update and rollback

```bash
cd /opt/voice-agent-console        # or your git checkout
sudo git pull
sudo npm ci --include=dev
sudo npm run build
sudo systemctl restart voice-agent-console.service
curl -fsS http://127.0.0.1:534/health/ready
```

Back up `/opt/voice-agent-console/data` and `.env` together before upgrades. Active calls drop on restart; update outside calling hours. If a release fails, check out the previous commit, rebuild, restart; keep the previous data directory.

---

## 8. Open items and accepted risks

These are recorded so nobody mistakes “green build” for “every product decision is finished”.

| ID | Risk | Decision required |
|---|---|---|
| SEC-09 | No CSRF token; protection relies on same-origin `Origin` + SameSite cookies | Add token if non-browser clients must be supported |
| SEC-10 | No MFA, breach screening or idle timeout; 7-day sessions | Required before exposing to untrusted operators |
| SEC-11 | Throttles are in-process | Single instance/edge WAF, or move counters to Redis |
| SEC-12 | Webhooks can reach loopback/private hosts (SSRF surface) | Intentional for local CRM/PBX; add private-IP deny mode for public deployments |
| SEC-13 | All accounts share all state and recordings | Add tenant scoping if multiple customers share one instance |
| SEC-14 | Legacy `ADMIN_PASSWORD` is a shared, non-attributable owner session | Bootstrap only; create named owners and rotate |
| SEC-16 | Recordings/DB not encrypted at rest | Use encrypted EBS, backups and retention policy |
| DOC-03 | `docs/` mirror not pruned when files leave `public/` | Add managed-file deletion to `sync-static-site.js` |
| DATA-01 | Server defaults are v5/4 agents; static fixture is v4/5 agents (Jessica) | Choose the canonical seed and migrate/test |
| DEP-01 | `requirements-test.txt` re-pins runtime packages | Switch to `-r requirements.txt` + constraints |
| DEP-02 | Build ID duplicated in three places | Generate from one source + CI parity check |
| GIT-01 | Session branch is committed (`a6f933e` plus audit artifacts) but still unpushed and has no PR | Push the branch and open a PR; CI must pass on the pushed commit |
| GIT-04 | GitHub Pages workflow fails because Pages is disabled | Enable Pages or disable the workflow |
| SIP-07 | Registration status exposes registrar host and bounded `lastError` to authenticated viewers | Decide whether to redact; no password is exposed |
| SIP-09 | SIP mode/registrar/credential/Bridge Host changes require a console restart; no live re-register action | Add a controlled restart action if zero-downtime reconfiguration is required |

`SEC-15` (VICIdial credentials in query strings) is accepted because the VICIdial API requires it; keep the PBX on loopback/private networking and rotate the API password. `SEC-17` (`unsafe-inline` in CSP) is accepted until inline handlers/styles are extracted.

---

## 9. Final release checklist

- [x] Deep audit completed, **60 findings** recorded in `AUDIT-FINDINGS-2026-11-19.csv`.
- [x] All Critical/High **code** findings fixed with regression coverage where testable; one High repository-state item (GIT-01) remains.
- [x] PR #47's VICIdial three-mode SIP connector merged into the audit branch, hardened and re-tested.
- [x] Junk/generated files removed from tracking; runtime state (`data/console-state.json`) preserved on disk and untracked.
- [x] Docker, systemd, README, release notes and AWS docs corrected.
- [x] `npm ci`, build, full test, audit, pytest, syntax and live HTTP smoke executed on the merged tree.
- [x] `public/` and `docs/` synchronized; static-site suite passed.
- [x] `dist/` rebuilt and committed, including the previously missing SIP registrar module.
- [ ] Push the branch and open a PR; let CI verify the pushed commit.
- [ ] Merge the PR to `main` and re-run the gates on the merge commit.
- [ ] Run one `docker build` + `docker run` on a Docker-capable host (recommended).
- [ ] Run `deploy/aws-deploy.sh` on the target EC2 instance and verify both health hops.
- [ ] Place one controlled Deepgram test and one isolated VICIdial/Asterisk test call.
- [ ] Register one test SIP account against the real registrar and confirm refresh/unregister.
- [ ] Replace the self-signed certificate with a trusted one before wider use.
- [ ] Rotate the bootstrap `ADMIN_PASSWORD` after creating named owners.

## 10. Branch and merge status (post-merge re-audit)

Inspected 2026-11-19 after merging `origin/main` and remediating PR #47.

| Question | Answer |
|---|---|
| Is the base branch `fix/release-manifest-future-css` merged into `main`? | **Yes.** PR **#46** merged it on 2026-11-16 (merge commit `bd964ba`). Base commit `204e5a0` is an ancestor of `origin/main`. |
| Is this session branch merged into `main`? | **No.** Local HEAD contains the audit, the merge of `origin/main` (`9e9625d`), the SIP remediation (`a6f933e`, `b5e3dfc`) and the audit artifacts (`ea44613`); it is **ahead of `origin/main`** (`7acd3ca`) with **no upstream**, **no remote branch** and **no PR**. |
| Is current `main` covered by this audit? | **Its code is.** `origin/main` (`7acd3ca`, PR #47 VICIdial three-mode SIP connector) was merged into the branch and every gate was re-run on the merged tree. `main` itself does **not** yet contain the SIP hardening or rebuilt `dist/`. |
| Is the branch's committed `dist/` consistent? | **Yes, locally.** `npm run build` emitted `dist/vici-sip-registration.js`; `dist/vici-bridge.js` imports it; both are committed in `a6f933e`. |
| Is `main` CI green? | **Product CI: success.** GitHub Pages workflow: **failure** at “Configure Pages”; the repository Pages API returns 404, so Pages is not enabled. The local branch has not been pushed, so CI has not run on the fixes. |
| What is required before deployment? | Push the branch, open a PR, let Product CI pass, merge, then run `npm ci && npm run build && npm test && npm audit` on the merged commit and execute the EC2/Docker/live-call steps. |

**Sign-off:** within the merged tree and the gates actually executed above, the console is build-clean, test-clean, dependency-clean and deployment-ready for a single-tenant AWS EC2 install. The current audit branch is **committed but not pushed, not reviewed and not merged**, and `main` still carries the unhardened SIP connector. The remaining unchecked boxes are environment execution and merge steps, not known defects in the audited code.

## 11. PR #47 VICIdial SIP connector — deep re-audit

### 11.1 What the merged feature does

`src/vici-sip-registration.ts` adds a minimal RFC 3261 UDP registrar client for **registration** and **hybrid** modes; **static peer** remains the default and unchanged. The existing SIP/RTP listener still receives calls. In registration mode the bridge builds a Contact from `sipUsername@bridgeHost:sipPort`, answers a `401`/`407` digest challenge (MD5, `qop=auth`), refreshes at ~80% of `Expires`, and sends `Expires: 0` on shutdown. Configuration and status are exposed through the VICIdial SIP panel; `VICI_SIP_PASSWORD` is a server-side managed secret.

### 11.2 Findings and remediation

| ID | Severity | Status | Finding and fix |
|---|---|---|---|
| SIP-01 | High | **Fixed** | The new registrar had **no automated tests** and was absent from `tools/run-tests.js`. Added `tests/sip-registration-verify.ts` with a mock UDP registrar and the `sip-registration` runner step. |
| SIP-02 | High | **Fixed** | `sipRegistrarHost`, `sipDomain`, `sipUsername`, `sipAuthUsername` and `bridgeHost` were interpolated into raw UDP headers without validation. `normalizeState` now applies `cleanSipHost`/`cleanSipUser` allowlists; `start()` re-validates header/URI characters; digest challenge values are quote-escaped and length-bounded. |
| SIP-03 | Medium | **Fixed** | Registration advertised the saved `sipPort` even when `BRIDGE_SIP_PORT` changed the actual listener. `src/vici-bridge.ts` now passes `{ ...vici, sipPort: this.sipPort }`. |
| SIP-04 | Medium | **Fixed** | A loopback, `0.0.0.0` or `::`/`[::]` Bridge Host could be registered as an unreachable Contact. Deployment preflight now reports it as an error and the client refuses to start. |
| SIP-05 | Medium | **Fixed** | Repeated `401`/`407` responses caused unbounded re-authentication. The client now fails closed after more than two consecutive challenges; the suite proves three requests then `failed`. |
| SIP-06 | Low | **Fixed** | `stop()` could throw when the UDP socket never bound, and it emitted a duplicate unregister. The close is now exception-safe and the second `Expires: 0` was removed. |
| SIP-07 | Low | **Open** | The authenticated status payload exposes the registrar address and a bounded `lastError`. The client adds no password or digest fields and the UI escapes the text; decide whether to redact the registrar host for viewer roles. |
| SIP-08 | Info | **Passed** | The SIP password never appears in any REGISTER. The suite asserts the request contains `Authorization: Digest username="1001"`, `qop=auth`, `algorithm=MD5`, `URI = sip:pbx.example.test` and `Contact: <sip:1001@203.0.113.10:5062;transport=udp>` with no secret. |
| SIP-09 | Low | **Open** | SIP mode, registrar, credentials and Bridge Host are read at bridge startup; changing them requires a console restart. The UI now says so explicitly; a live re-register action is not implemented. |
| UI-01 | Medium | **Fixed** | Real operator IPs (`115.186.137.240`, `192.168.18.29`, `3.107.192.118`) were hard-coded in UI placeholders, status text, `.env.example`, deploy comments, the ViciBox runbook and AWS deployment docs. Replaced with `127.0.0.1`, `YOUR-BRIDGE-HOST`, `<BRIDGE_PUBLIC_IP>`, `<VICIBOX_PUBLIC_IP>` and `<EC2_PUBLIC_IP>`. |

### 11.3 Verification executed for the SIP path

`node tools/run-tests.js sip-registration` passes **7/7**:

1. digest `401` → authenticated REGISTER → `200` `registered` → clean stop/unregister;
2. unsupported digest algorithm fails closed;
3. repeated `401` challenges stop after a bounded retry count;
4. loopback Contact and CRLF/header-injection inputs are rejected;
5. imported SIP configuration is stripped of header/control characters;
6. deployment preflight rejects a missing registrar and loopback Contact;
7. `VICI_SIP_PASSWORD` is excluded from provider placeholder interpolation.

Also verified: `npm run build` emits the new module and the bridge requires it; `npm test` includes the suite in the 18-suite/120-check run; `npm audit` reports 0 vulnerabilities; no server secret is logged or written into the export (which emits only `VICI_SIP_PASSWORD=***`).

### 11.4 Residual limits and operator guidance

- **No live registrar was contacted.** Digest/refresh/unregister behavior is proven against a local mock only; registrar-specific nonce/`qop`/NAT behavior must be tested with the real PBX account.
- **UDP + MD5/`qop=auth` only.** TLS/TCP and SHA-256/AKA challenges fail closed by design.
- **`Call-ID`/`CSeq`/From-tag correlation is not verified** on responses; the client filters by resolved registrar IP and source port. Keep the registrar on a trusted network and use a dedicated account.
- **Registration does not replace VICIdial remote-agent session semantics.** It only makes the bridge's SIP listener reachable through the registrar; the dialer still has to send a call to that Contact and preserve the call identity.
- **Restart after changes.** Apply SIP changes during a maintenance window; active calls drop when the console restarts.
