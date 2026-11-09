# 🎙️ Voice Agent Console — Deepgram Voice Agent API + Universal VICIdial Bridge

Unified production **Node.js + TypeScript** platform combining:
1. **Multi-Agent & Multi-Campaign Configuration Console** (`SQLite WAL` + JSON mirror + revision history + 18-rule pre-flight schema validator)
2. **Live Deepgram Voice Lab** (139 real `Flux v2` & `Aura-2 / v1` voices, studio `.wav` preview proxy, live TTS greeting synthesizer, and 1-click **"Set as Agent Voice"**)
3. **Live Bot browser voice test** (`/ws/simulator`, WebAudio `16 kHz`/`24 kHz` wideband or `8 kHz` test audio, using the Deepgram Voice Agent API; not a live telephone call)
4. **Co-Located Universal VICIdial Bridge** (`SIP + RTP G.711 μ-law` on UDP `:5062` for **all** Asterisk 13/16/18+ ViciBox servers **+** native Asterisk 18+ `AudioSocket` on TCP `:9092`)
5. **Production Hardening, Stereo `.wav` Call Recordings & Supervisor Wallboard** (`ADMIN_PASSWORD` auth with localhost Asterisk whitelist, `BRIDGE_ALLOWED_IPS` & `maxCalls` guards, 2-channel `8 kHz` `.wav` recording playback, CSV CDR reports, live supervisor `Force Transfer` / `Force Hangup`, and custom HTTP Webhook tool execution)

---

## Public GitHub Pages demo

**https://muneeb819.github.io/Voice-Agent-Console/**

This is the browser-only static demo, published from `public/` after changes land on `main`. Its accounts and saved settings stay in the current browser; it does **not** deploy the Node API, WebSocket backend, or VICIdial bridge. Do not enter production credentials or rely on browser-local accounts for security. See the deployment section below for the full server requirements.

`public/` is the canonical frontend. After changing it, run `npm run sync:static` to update the legacy `docs/` mirror, then `npm run build` and `npm test`. CI checks that both copies match and exercises static login/signup, cookie-only backend login, and legacy token cleanup.

---

## 📂 Project Structure

```text
voice-agent-console/
├── src/
│   ├── server.ts                 # Unified Express + WebSocket upgrade server (:533)
│   ├── types.ts                  # Shared TypeScript interfaces
│   ├── defaults.ts               # Default console state & legacy vac-v2 state migration
│   ├── settings-builder.ts       # Deepgram Settings builder, 18-rule validator & ViciBox dialplan generator
│   ├── greetings.ts              # Validated CSV-derived greeting catalog loader
│   ├── opening.ts                # Shared opening-composer/timing adapter
│   ├── env-store.ts              # Server .env secret manager, sanitizer & Deepgram connection verifier
│   ├── db.ts                     # SQLite WAL persistence, revisions, CDRs, analytics & CSV exporter
│   ├── deepgram-catalog.ts       # Live Deepgram /v2/models + /v1/models catalog & TTS synthesizer
│   ├── live-simulator.ts         # Browser <-> Deepgram Voice Agent WebSocket proxy & comfort-silence streamer
│   ├── g711.ts                   # ITU-T G.711 μ-law <-> linear16 LUT codec, RTP framing & RFC 4733 DTMF
│   ├── vici-client.ts            # VICIdial CallerID parser + Non-Agent API & Agent API (ra_call_control) client
│   ├── ami-client.ts             # Asterisk Manager Interface (:5038) TCP client (Ping, Redirect, Hangup)
│   ├── vici-bridge.ts            # Dual-transport SIP+RTP (:5062) & AudioSocket (:9092) call orchestrator
│   ├── vici-loopback-tester.ts   # Binary SIP/RTP & AudioSocket hardware-loopback call simulator
│   ├── call-recorder.ts          # Timeline-accurate 8 kHz Stereo WAV recorder (L=Caller, R=Bot)
│   ├── simulator-recordings.ts  # Private, opt-in browser-test audio storage (separate from bridge calls)
│   ├── webhook-executor.ts       # Custom Function HTTP Webhook executor (.env + lead template interpolation)
│   └── auth-guard.ts             # HMAC cookie/Bearer auth + explicit PBX peer allowlist
├── datasets/Greetings-Dataset.csv # Original 1,100-row greeting dataset
├── public/
│   ├── index.html                # Single-Page Operator & Supervisor Console
│   ├── styles.css                # Dark-mode responsive telemetry & studio styling
│   ├── greetings.json             # Generated greeting catalog, also mirrored to docs/
│   ├── opening.js                 # One-second listen/configured-opening gate, also mirrored to docs/
│   └── app.js                    # Console UI, WebAudio engine, Wallboard & Live Bridge controls
├── deploy/
│   ├── vicibox-install.sh        # One-command co-located ViciBox (OpenSUSE / Ubuntu / Debian) installer
│   └── voice-agent-bridge.service # Hardened systemd service unit (Restart=always)
├── tests/
│   ├── mock-audio-verify.ts      # Mock call PCM streaming, agent speaking UI, barge-in & cleanup
│   ├── opening-verify.ts         # Composition, migration, timing, cancellation & early caller
│   ├── bridge-opening-verify.ts  # Local AudioSocket/SIP+RTP timing and playback-drain fixtures
│   ├── greetings-verify.ts       # Catalog, rotation, fallback and selection logging
│   ├── step1-verify.ts           # Catalog, TTS, schema & UI bug regressions, SQLite
│   ├── step2-verify.ts           # Simulator WS, comfort silence & optional live Deepgram
│   ├── step3-verify.ts           # G.711/RTP, mock bridge, AMI & Vici APIs
│   └── step4-verify.ts           # Auth, guards, recordings, webhooks & mock Medicare scenarios
├── docs/
│   ├── AUDIT-REPORT.md           # Original architectural & protocol audit report
│   └── MEDICARE-BOT-TRAINING-BLUEPRINT.md # Full Medicare Food & OTC Lead Qualification Bot script & gate rules
├── VICIBOX-PRODUCTION-RUNBOOK.md # Step-by-step ViciBox CLI & VICIdial Admin Go-Live Runbook
├── start.sh / start.bat          # One-command local Linux/macOS & Windows launchers
├── .env.example                  # Template server environment configuration
├── package.json
└── tsconfig.json
```

---

## 🤖 Built-In Outbound Qualification Agents & Multi-Campaign Routing

The Console includes example outbound qualification bots with sample VICIdial extension and Remote Agent mappings. They are **not verified as production-ready**; review the identity, benefit claims, scripts, eligibility rules, disclosures and actual routing before any calls:

| Slot | Agent | VICIdial Campaign | Dialplan Exten / Remote Agent | Closer In-Group | Key Gate & Compliance Rules |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **#1** | `Final Expense — Warm Intro` (`a1`) | `FETEST` (`c1`) | `88001` / `RA 9001` | `FE_CLOSERS` | Senior burial/final-expense screen (`50–85`), warm closer handoff, DNC compliance |
| **#2** | `Medicare — Food & OTC Advisor` (`a_medicare`) | `MEDICARE` (`c_medicare`) | `88002` / `RA 9002` | `MED_CLOSERS` | Caller-confirmed **Medicare Part A/B** satisfies the sample campaign qualification step; the bot must not ask or infer age/DOB. Only a volunteered age outside the operator-defined `65–85` band disqualifies. Consent-based specialist handoff, `flux-general-multi` (`en,es`) Spanish `LANG` exit, DNC handling, and caller-stated-only closer metadata (`Name`, optional `Age`, `Medicare`, `Hook`) |

---

## 🚀 Quickstart (Local / Dev)

```bash
npm install
cp .env.example .env
# Add DEEPGRAM_API_KEY=... to .env (or configure via "🔑 API Keys" in the web UI)

npm run build
npm start
# Or simply run ./start.sh (Linux/macOS) or start.bat (Windows)
```

Open **`http://127.0.0.1:533`**. With no admin password or users, create the first account directly on loopback; proxied bootstrap is intentionally blocked. Once authentication is enabled, only a signed-in **owner or admin** can create another account. Accounts carry a role (`owner`, `admin`, `operator`, `qa`, `viewer`) and an active flag: privileged routes (secrets, state reset, release bundle, deploy script, provider verification, account administration, live-call hangup/transfer) require owner/admin, and `viewer` accounts are read-only. Roles gate actions, **not records** — all accounts still share one console state.

Passwords for new or changed accounts must be at least 15 characters; existing shorter passwords keep working. Under **Account → Password & Sessions**, a signed-in account can rotate its password (which signs out every other device) or revoke its other sessions. Owners/admins can list accounts, change roles, disable accounts and revoke their sessions under `/api/users`; the last active owner cannot be disabled or demoted, and an `admin` cannot manage owner accounts or grant ownership. Disabling an account or demoting it to `viewer`/`qa` revokes its live sessions immediately.

Troubleshooting: **[`docs/BACKEND-TROUBLESHOOTING.md`](./docs/BACKEND-TROUBLESHOOTING.md)** maps every real error code to its cause and fix. Security status: **[`docs/security/BACKEND-AUDIT-2026-11-09.md`](./docs/security/BACKEND-AUDIT-2026-11-09.md)**.

### Imported greetings and call rotation

- The supplied `datasets/Greetings-Dataset.csv` contains **1,100** greetings, each retaining its ID, persona, context, full text and tone. Server startup imports the bundled catalog idempotently into SQLite. Browse or search it under **Agents**. Labels do not select a bot or provider voice.
- For each agent, set a **brief saved opening and identity** under **Agents** and save. For example: “Hi! This is Jessi from Example Services. How are you doing today?” Use your own verified identity. Rotation is enabled by default; a selected row varies the saved salutation and/or general question using suitable fragments or a short fallback, rather than appending the full imported greeting. To keep the saved opening unchanged, uncheck **Vary this opening using the imported greeting library** and save. Duplicates copy the source setting; newly created agents default to rotation on. Previews do not consume a selection.
- Each bot randomly draws all 1,100 IDs without repeating until the pool is exhausted, avoiding the last ID at the next cycle boundary. The selector prefers a different composed wording from the preceding draw when another unused row permits it; different IDs can map to identical wording, so an occasional repeat remains possible, especially near the end of a cycle or with an unvaryable custom opening. Server-backed bridge calls and Live Bot tests share the bot's SQLite rotation across restarts and concurrent processes using the same database. Failed or interrupted starts can advance the rotation. Separate databases have separate rotations.
- The campaign's spoken recording notice is **optional**. New agents and settings with no prior choice default to off; existing explicit choices are preserved. Change **Include the linked campaign recording notice** under **Agents** or **Live Bot**, then **Save & verify** to retain the per-agent choice. An unsaved Live Bot change applies to that test; bridge calls use saved settings. This controls the spoken notice only, not recording. A notice written inside the saved opening is not removed. Obtain any consent and make any disclosure required in your jurisdiction.
- **Opening timing:** after the provider acknowledges settings, the app listens for caller speech for one full second while caller audio continues upstream. A silent line then receives the configured opening once; an early caller turn takes priority and is answered without a duplicate opening. Silence alone never hangs up or applies a disposition. Comfort-silence PCM keep-alive remains enabled. This is timed from provider readiness, not from the moment a telephone is answered; provider turn detection, message acceptance, network delay and playback remain variable, and offline tests cannot prove what a real caller heard.
- Selected IDs appear in Live Bot session details and saved server test history, bridge CDRs and CSV export. An ID records the selection, **not proof that audio was heard**. If selection fails or the library is empty, the saved opening is used and the session reports a warning. Lead placeholders are hydrated when enabled.
- **Static hosting:** `docs/greetings.json` supports direct-browser Live Bot tests. Rotation is separate from server calls and shared only within that browser profile via IndexedDB. If storage is blocked, a temporary cycle is kept in the current tab and a warning is shown; clearing site data resets it. Static history is retained only for opted-in recorded tests.

The exact old stock Nova and Food & OTC openings are migrated to shorter defaults. Exact retired stock Medicare prompts, campaign rules and self-introductions are migrated to the current consent-handoff policy; Jessica keeps Jessica's identity. Customized openings, prompts, rules and introductions are not silently replaced. A long or multi-question custom opening can therefore remain long; edit it yourself if needed. The library's tone labels do not guarantee vocal prosody.

**Review before placing calls:** the example Medicare / Food & OTC prompts and historical blueprint contain unverified representations, affiliations, eligibility rules and benefit claims, including state approval and card availability. Do not use these assertions without substantiation and appropriate review. Review all other agent scripts, identity, purpose, notice and consent requirements as well. The console does not verify them.

The original CSV is the source for the two browser catalogs. After intentionally changing it, run `python3 tools/build-greetings.py` (or `--check` to verify parity) and update the pinned dataset hash, counts and example assertions in `tests/greetings-verify.ts`. The server seeds missing IDs on startup but does not overwrite already imported database rows; editing the file alone does not update existing SQLite records. Back up the database before any manual changes.

### Live Bot and test history

1. In **Plug-ins**, select and save supported STT, LLM and TTS providers/models; set `DEEPGRAM_API_KEY` under **API Keys**. In **Live Bot**, choose an agent and start a microphone or speaker-and-text browser test. The status changes to connected only after Deepgram accepts the settings. A working provider account, browser audio permission and network access are required; provider usage can incur charges.
2. This is a **browser test, not a VICIdial telephone call**. Its transfer, disposition and DNC function requests are reported as not executed. The `end_call` function ends the browser test. Custom webhooks are off by default: explicitly enable them for a test only if their real external side effects are acceptable. Webhook redirects are rejected rather than followed; configure the final endpoint directly. Static-host mode cannot run those server-side webhooks.
3. Audio recording for a **new** Live Bot test is **off by default**. If everyone whose voice may be captured has consented, check **Record audio for this test**, then start the test. The choice resets when the test ends. Go to **Recent Browser Test History** for the same agent, choose **Load audio recording**, and use the player or download link. Expand **Show all retained tests** if needed. A recording can be deleted without deleting the transcript; **Clear History** deletes that agent's history and attached recordings. Older tests made without recording have no audio and cannot be recovered. Older sandbox/local-speech transcripts were scripted and are labeled as such.
4. VICIdial bridge calls and bridge loopback tests are a separate path. When a bridge entry has a recording, find it under **Wallboard → Stereo 8 kHz Call Recordings & SQLite CDR Archive** (or **Vici Bridge → Recent SQLite Bridge Call CDRs**) and use the audio player or `.wav` download. A mock-AI bridge recording may contain synthetic test audio rather than an intelligible conversation. Recordings are retained separately from browser test logs. Verify consent and recording requirements for your jurisdiction before making calls.

#### Browser-test recording: storage and limits

- The recording is a **mixed browser capture** of the microphone (unless muted or unavailable) and agent audio actually played by the browser; it is not a separate caller/bot stereo WAV. Speaker-and-text mode records only agent playback; typed text is not converted into speech. A compatible browser with `MediaRecorder` and Web Audio is required. Tab suspension, audio devices, browser restrictions, network interruptions or an interrupted save can yield incomplete or missing audio.
- Recording stops at 10 minutes or near the 20 MiB size limit; the test may continue without further recording. History marks a limit-truncated recording. Keep the tab open through **Saving recording…**. If saving fails or cannot be confirmed and audio is available, download the temporary copy immediately; it is lost on reload or when the tab closes. A partial copy may not play correctly.
- **Server mode:** completed audio is uploaded to the server and attached to its saved test log. By default it is stored in `data/simulator-recordings/` (or `VAC_DATA_DIR/simulator-recordings/`); owner-only filesystem permissions are requested where supported, but audio is not encrypted at rest. The latest 100 browser-test logs across all agents are retained, with associated files deleted when logs are evicted or cleared. Transcripts are saved even when audio is off. All signed-in operators can access these recordings; there is no per-user isolation. Use HTTPS, restrict server access, protect backups and downloads, and secure any custom data directory.
- **Static-host mode:** opted-in audio and its transcript are stored in this browser profile's IndexedDB for this site, not in server test history. The most recent 20 recorded-test entries across agents are kept, with older associated audio removed; unrecorded static-site tests are not saved. Other users or extensions with access to the browser profile may be able to read the data; private browsing, storage eviction, quota limits or clearing site data can remove it. Live microphone audio and text are still sent to Deepgram to conduct the test.
- Deletion removes the app's stored copy, not downloads, backups, browser/OS caches or other copies. Server recordings and SQLite history should be backed up together when needed. Protect backups and follow applicable consent, retention and deletion requirements.

Bridge loopback tests use a mock VICIdial API, so their transfer, disposition and DNC responses do not prove real updates. Historical bridge records do not reliably distinguish tests from live calls. **Run bridge loopback tests only on an isolated instance with no live calls**: they temporarily change shared bridge/provider routing, and configured custom webhooks may still execute for real. Static-site mode cannot run a bridge test and no longer displays its old synthetic browser-local bridge records as live CDRs.

Scripted sandbox responses and the fake local-speech conversation have been removed. The local speech service still supports standalone health checks and voice previews, but it does not currently provide an LLM-backed Live Bot conversation. The decorative text-driven avatar was removed; the Live Bot stage shows provider-reported call state only. Microphone byte counts show data queued to the socket, not proof of transcription. Review existing custom agent prompts and deployments before placing real calls; apart from the exact stock migration noted above, customized prompts are preserved.

The **Dashboard** is the first navigation item and the default page; existing `?tab=` links to individual sections still work. Its scores are configuration estimates, not certifications or proof of live connectivity.

### Console layout, saving and Fleet Matrix

- The header keeps only the centered, full landscape MMA banner for the active theme (the square icon remains the favicon). The banner is **live**: the waveform baked into the artwork is masked out and replaced with CSS-animated bars in the same windows, so the waves move continuously and brighten while an agent is speaking. Motion is compositor-only (`transform`), honors `prefers-reduced-motion` by restoring the original static artwork, and is decorative — it is not a meter of microphone or provider audio. Theme Studio is the small icon at the bottom-left of the side panel; API Keys and account/session links are at the bottom-right.
- Side-rail sections, Dashboard KPI/compact pills, setup shortcuts and Fleet Matrix campaign/bot links are real anchors with project-relative `?tab=` URLs. Right-click → **Open link in new tab**, Ctrl/Cmd/Shift-click and middle-click use the browser's native behavior; a plain left click still navigates in-app without a full reload. New tabs load the last saved/shared configuration and the selected bot/campaign or Fleet detail from the URL, not another tab's uncommitted draft.
- Configuration edits are explicit-save. Moving between sections does not force a save or discard the draft; the bottom-right **Save & Verify** dock appears only while changes need saving or a failed save needs retry. **Discard** restores the last saved state. The original tab can recover its own unsaved draft after a reload, but static-demo saved settings still live only in that browser profile.
- **Fleet Matrix** starts with campaign names only. Selecting a campaign opens its live activity badge, configuration readiness, assigned bots, and retained-call analytics. **Active** means the connected bridge currently reports a live call for that campaign; **Inactive** means it reports none. Static demos show **Status unavailable** rather than inventing production activity. Analytics cover retained records only (up to 200 bridge calls and 100 browser tests across the console), not lifetime totals.

See [opening test results](OPENING-TEST-RESULTS.md) for this release's commands, results and limitations. The tests use temporary data and environment files, loopback ports, synthetic credentials and mocked services. External `fetch` calls are blocked by default and the live Deepgram test is reported as skipped. A live run may incur provider charges and requires explicit opt-in with `VAC_TEST_LIVE=1` and a test key:

```bash
npm run build
npm test
# Only with permission and a dedicated test key:
# VAC_TEST_LIVE=1 DEEPGRAM_API_KEY=... npm test
```

## Docker / Render Deployment

The full console needs a long-running Node 22.5+ service with WebSocket support. Configure a strong `ADMIN_PASSWORD` or create a local account before binding to a non-loopback address or opening a public demo tunnel. For Docker, set `HOST=0.0.0.0`, supply credentials through your deployment's secret manager, and keep SIP and AudioSocket ports private. For a remote PBX, explicitly set `BRIDGE_BIND_HOST` and a restrictive `BRIDGE_ALLOWED_IPS`; the defaults allow loopback only. Set `TRUST_PROXY` only to the addresses/CIDRs of a trusted reverse proxy which overwrites forwarded headers; it is needed for correct client-IP throttling, secure cookies, and same-origin HTTP/WebSocket checks behind TLS termination. Incorrect proxy trust can prevent browser API and WebSocket access. Never expose an unauthenticated bootstrap instance through a reverse proxy.

Browser API calls and WebSocket upgrades with an `Origin` must be same-origin; the console no longer advertises wildcard CORS. Non-browser clients may omit `Origin`. Local unauthenticated bootstrap and local PBX exemptions also require a loopback Host (`localhost`, `127.0.0.1`, or `[::1]`) to reduce DNS-rebinding risk. Deployments that need cross-origin access should use a same-origin reverse proxy rather than opening CORS. For a local cloudflared demo, configure an appropriate `TRUST_PROXY` (for example `loopback` when cloudflared connects directly from loopback) and restart the console; the launcher checks authentication and proxy readiness before opening the tunnel.

The ViciBox installer preserves existing `.env` settings and creates a loopback-only configuration for a new installation. Review all listener, PBX, TLS and firewall settings before allowing remote traffic. `BRIDGE_SIP_PORT` overrides the saved console port. Occupied HTTP, AudioSocket, or SIP ports now fail startup instead of silently hopping to another port; align the generated VICIdial configuration with the configured listeners before placing calls. For wildcard binds with a remote PBX, set a reachable advertised `bridgeHost` explicitly. The `vercel.json`/GitHub Pages deployment is a static demo only: its browser-local accounts do **not** secure a server, and it provides no API, WebSocket backend or telephony bridge.

The release bundle contains only files listed in `tools/release-manifest.json`; add new release files to that manifest. Transparent full-banner WebP assets are generated from the JPEG masters in `brand-source/` with `python3 tools/build-brand-assets.py` (dependencies: `tools/requirements-brand.txt`); `--check` verifies the committed RGBA pixels and alpha cut in CI. The masters are not shipped as browser assets. Runtime data, credentials and symlinks are excluded. Analytics describe the retained 200 bridge and 100 simulator calls, not lifetime totals.

---

## ☁️ Publishing on AWS EC2 (HTTPS)

To serve the console over HTTPS on your own instance (for example
`https://<instance-ip>:533/`), run `sudo bash deploy/aws-deploy.sh --ip <instance-ip>`
on that instance. It installs the app on loopback, puts nginx in front for TLS,
and verifies both hops. See **[`docs/AWS-DEPLOYMENT.md`](./docs/AWS-DEPLOYMENT.md)**
for prerequisites, the security-group rule you must add, and why a bare IP
address can only get a self-signed certificate.

---

## ☎️ Co-Located ViciBox Production Deployment (5 Minutes)

See **[`VICIBOX-PRODUCTION-RUNBOOK.md`](./VICIBOX-PRODUCTION-RUNBOOK.md)** for full VICIdial Admin screenshots/settings (`User 6666`, `FE_CLOSERS` In-Group, `AIBRIDGE` Carrier on `115.186.137.240:5062`, and `Remote Agent 9001`).

```bash
git clone https://github.com/muneeb819/Voice-Agent-Console.git /tmp/voice-agent-console
cd /tmp/voice-agent-console
sudo bash deploy/vicibox-install.sh
```

Then populate `/opt/voice-agent-console/.env` (`DEEPGRAM_API_KEY`, `VICI_API_PASS`, `AMI_SECRET`) and restart:

```bash
sudo systemctl restart voice-agent-bridge.service
```
