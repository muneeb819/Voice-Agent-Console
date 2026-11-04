# 🎙️ Voice Agent Console — Deepgram Voice Agent API + Universal VICIdial Bridge

Unified production **Node.js + TypeScript** platform combining:
1. **Multi-Agent & Multi-Campaign Configuration Console** (`SQLite WAL` + JSON mirror + revision history + 18-rule pre-flight schema validator)
2. **Live Deepgram Voice Lab** (139 real `Flux v2` & `Aura-2 / v1` voices, studio `.wav` preview proxy, live TTS greeting synthesizer, and 1-click **"Set as Agent Voice"**)
3. **Browser Live Call Simulator** (`/ws/simulator` WebAudio `16 kHz`/`24 kHz` wideband & `8 kHz` telephony testing against `wss://agent.deepgram.com/v1/agent/converse` + zero-cost Sandbox mode)
4. **Co-Located Universal VICIdial Bridge** (`SIP + RTP G.711 μ-law` on UDP `:5062` for **all** Asterisk 13/16/18+ ViciBox servers **+** native Asterisk 18+ `AudioSocket` on TCP `:9092`)
5. **Production Hardening, Stereo `.wav` Call Recordings & Supervisor Wallboard** (`ADMIN_PASSWORD` auth with localhost Asterisk whitelist, `BRIDGE_ALLOWED_IPS` & `maxCalls` guards, 2-channel `8 kHz` `.wav` recording playback, CSV CDR reports, live supervisor `Force Transfer` / `Force Hangup`, and custom HTTP Webhook tool execution)

---

## 📂 Project Structure

```text
voice-agent-console/
├── src/
│   ├── server.ts                 # Unified Express + WebSocket upgrade server (:533)
│   ├── types.ts                  # Shared TypeScript interfaces
│   ├── defaults.ts               # Default console state & legacy vac-v2 state migration
│   ├── settings-builder.ts       # Deepgram Settings builder, 18-rule validator & ViciBox dialplan generator
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
│   ├── webhook-executor.ts       # Custom Function HTTP Webhook executor (.env + lead template interpolation)
│   └── auth-guard.ts             # HMAC cookie/Bearer auth + explicit PBX peer allowlist
├── public/
│   ├── index.html                # Single-Page Operator & Supervisor Console
│   ├── styles.css                # Dark-mode responsive telemetry & studio styling
│   └── app.js                    # Console UI, WebAudio engine, Wallboard & Live Bridge controls
├── deploy/
│   ├── vicibox-install.sh        # One-command co-located ViciBox (OpenSUSE / Ubuntu / Debian) installer
│   └── voice-agent-bridge.service # Hardened systemd service unit (Restart=always)
├── tests/
│   ├── step1-verify.ts           # 12 automated checks (Catalog, TTS, Schema & UI bug regressions, SQLite)
│   ├── step2-verify.ts           # 7 automated checks (Live Simulator WS, Comfort Silence, Live Deepgram E2E)
│   ├── step3-verify.ts           # 9 automated checks (G.711/RTP, AudioSocket, Live 8kHz SIP+RTP, AMI, Vici APIs)
│   └── step4-verify.ts           # 9 automated checks (Auth, IP/Capacity guards, Stereo WAV, Webhooks, CSV, Medicare E2E)
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

Out of the box, the Console ships with two production-ready outbound voice qualification bots mapped to dedicated VICIdial extensions & Remote Agents:

| Slot | Agent | VICIdial Campaign | Dialplan Exten / Remote Agent | Closer In-Group | Key Gate & Compliance Rules |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **#1** | `Final Expense — Warm Intro` (`a1`) | `FETEST` (`c1`) | `88001` / `RA 9001` | `FE_CLOSERS` | Senior burial/final-expense screen (`50–85`), warm closer handoff, DNC compliance |
| **#2** | `Medicare — Food & OTC Advisor` (`a_medicare`) | `MEDICARE` (`c_medicare`) | `88002` / `RA 9002` | `MED_CLOSERS` | Food & OTC Card hook, strict **Part A/B + Age `65–85`** hard-stop gate, `flux-general-multi` (`en,es`) instant Spanish `LANG` exit, verbatim `DNC` & scam-reassurance scripts, structured closer screen-pop metadata (`Name`, `Age`, `Medicare`, `Hook`) |

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

Open **`http://127.0.0.1:533`**. With no admin password or users, create the first account directly on loopback; proxied bootstrap is intentionally blocked. Once authentication is enabled, only a signed-in operator can create another account. All accounts currently have full operator privileges; there is no role separation.

The tests use temporary data and environment files, loopback ports, synthetic credentials and mocked services. External `fetch` calls are blocked by default and the live Deepgram test is reported as skipped. A live run may incur provider charges and requires explicit opt-in with `VAC_TEST_LIVE=1` and a test key:

```bash
npm run build
npm test
# Only with permission and a dedicated test key:
# VAC_TEST_LIVE=1 DEEPGRAM_API_KEY=... npm test
```

## Docker / Render Deployment

The full console needs a long-running Node 22.5+ service with WebSocket support. Configure a strong `ADMIN_PASSWORD` or create a local account before binding to a non-loopback address or opening a public demo tunnel. For Docker, set `HOST=0.0.0.0`, supply credentials through your deployment's secret manager, and keep SIP and AudioSocket ports private. For a remote PBX, explicitly set `BRIDGE_BIND_HOST` and a restrictive `BRIDGE_ALLOWED_IPS`; the defaults allow loopback only. Set `TRUST_PROXY` only to the addresses/CIDRs of a trusted reverse proxy which overwrites forwarded headers; it is needed for correct client-IP throttling, secure cookies, and same-origin HTTP/WebSocket checks behind TLS termination. Incorrect proxy trust can prevent browser API and WebSocket access. Never expose an unauthenticated bootstrap instance through a reverse proxy.

Browser API calls and WebSocket upgrades with an `Origin` must be same-origin; the console no longer advertises wildcard CORS. Non-browser clients may omit `Origin`. Local unauthenticated bootstrap and local PBX exemptions also require a loopback Host (`localhost`, `127.0.0.1`, or `[::1]`) to reduce DNS-rebinding risk. Deployments that need cross-origin access should use a same-origin reverse proxy rather than opening CORS. For a local cloudflared demo, configure an appropriate `TRUST_PROXY` (for example `loopback` when cloudflared connects directly from loopback) and restart the console; the launcher checks authentication and proxy readiness before opening the tunnel.

The ViciBox installer preserves existing `.env` settings and creates a loopback-only configuration for a new installation. Review all listener, PBX, TLS and firewall settings before allowing remote traffic. The `vercel.json`/GitHub Pages deployment is a static demo only: its browser-local accounts do **not** secure a server, and it provides no API, WebSocket backend or telephony bridge.

The release bundle contains only files listed in `tools/release-manifest.json`; add new release files to that manifest. Runtime data, credentials and symlinks are excluded. Analytics describe the retained 200 bridge and 100 simulator calls, not lifetime totals.

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
