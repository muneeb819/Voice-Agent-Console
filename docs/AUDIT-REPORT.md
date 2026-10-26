# Quick Audit & Status Report: Voice Agent Console + VICIdial Project

**Audit Date:** October 26, 2026  
**Reviewed Artifacts:**  
1. Claude Shared Chat History (`3bc0c9a9-ac4f-45fd-8d0e-dac29e2ef0d2` — 3 iterations)  
2. Attached Codebase (`voice-agent-console.html` — v2, 161 lines, 27.8 KB single-file SPA)

---

## 1. Executive Summary — Where Does This Stand Right Now?

**Overall Production Readiness: ~28% (UI Config Prototype Only — No Backend, No Real Voice API, No Live Dialer Bridge)**

Right now, you have a **clean, single-file browser configuration prototype (`voice-agent-console.html`)** stored only in browser `localStorage`. In the Claude chat, Claude built v1 (5 tabs), upgraded it to v2 (7 tabs with Save & Verify, Plug-ins, `accept_vicidial_call`, and browser-based OS speech preview), and then paused at Turn 3 when you asked about plugging in a **Deepgram API key** to pull real voices—correctly explaining that a static browser artifact cannot securely hold API keys or reach Deepgram/VICIdial without a backend server.

Critically, **Claude explicitly noted in both builds that it never opened or clicked through the page**. Our code and protocol audit found **13 concrete bugs** across three areas:
1. **VICIdial / Asterisk integration design flaws** that would fail on a real ViciBox dialer (wrong API endpoints, broken ingroup transfer method, unmapped AudioSocket UUIDs, and `accept_vicidial_call` misdesigned as an LLM tool).
2. **Deepgram Voice Agent API schema mismatches** (false validation errors on Google Gemini, incomplete Cartesia/ElevenLabs payloads, unvalidated Flux parameter constraints, and invalid custom STT provider options).
3. **Frontend state & UI bugs** (duplicate function IDs, renaming functions breaking agents, opening the Testing tab triggering fake "Unsaved changes", stringified numbers, and export key collisions).

---

## 2. Requirement-by-Requirement Status Matrix

| # | Your Requirement (from Chat History) | Current Status | Completion | Reality Check |
|---|---|---|---|---|
| 1 | **Bot Persona & Settings Builder** (Deepgram `Settings` spec) | 🟡 **Prototype Ready** | **80%** | Builds Deepgram `Settings` JSON (Flux v2, Aura v1, LLM, greeting, prompt, EOT thresholds, `defer_until_eot`). Needs 4 schema validation fixes. |
| 2 | **Save & Verify Workflow** (`Save & verify` + `Discard`) | 🟢 **Working in Browser** | **85%** | Dirty-state indicator, diff log, and 20 pre-flight checks work, but saves **only to local browser storage** (`localStorage`). |
| 3 | **Dynamic Plug-ins (STT, LLM, TTS & Functions)** | 🟡 **Partial / Buggy** | **65%** | UI supports adding/editing providers & functions, but suffers from function ID collisions, broken renames, and provider schema bugs. |
| 4 | **Voice Testing & Deepgram Voice Picker** | 🔴 **Placeholder Only** | **15%** | Plays your **device/OS built-in robotic voices** (`window.speechSynthesis`). Cannot fetch Deepgram `/v1/models` voices or play real Aura/Flux/ElevenLabs audio yet. |
| 5 | **Bot Verification / QA Testing** | 🔴 **Manual Checklist** | **20%** | Static pass/fail/pending notes table + static config linter. Cannot talk to the bot via microphone or run automated conversation tests. |
| 6 | **VICIdial Deployment** (Receive, Process & Transfer Calls) | 🔴 **Not Built** | **10%** | Only renders a static 18-line text snippet. **Zero backend/bridge code exists yet**, and the generated dialplan/API design has critical VICIdial flaws. |

---

## 3. Critical Findings: VICIdial & Telephony Architecture

Before writing the Node.js bridge server, these **4 architectural issues** in the current console template must be corrected so calls actually work on VICIdial:

### 3.1 `accept_vicidial_call` Is Modeled as an LLM Function Instead of a Bridge Lifecycle Event *(Critical)*
- **Where:** `voice-agent-console.html` lines 44, 49, 89, 117.
- **What's wrong:** `accept_vicidial_call` is placed inside `agent.think.functions` with `required: ["uniqueid"]`, and the system prompt instructs the LLM: *"When the call connects, call accept_vicidial_call."*
  1. In Deepgram's Voice Agent API, `agent.greeting` speaks **before** the LLM runs.
  2. On turn 1, the LLM **does not know** the Asterisk `uniqueid`, `lead_id`, or `phone_number`, so it will hallucinate fake values and burn an extra LLM tool-call round-trip (causing awkward dead air for the customer) on a call Asterisk already answered.
- **How to fix:** Accepting the call and fetching lead details is the **Bridge server's job**, *before* sending `Settings` to Deepgram. On call connect, the Bridge reads the VICIdial call metadata, fetches the lead (`first_name`, `age`, `state`, `lead_id`), injects those variables into `agent.think.prompt`, and then starts the Deepgram session. Keep only **`transfer_to_live_agent`**, **`set_disposition`**, and **`end_call`** (plus optional CRM lookups) as LLM functions.

### 3.2 VICIdial Agent API vs. Non-Agent API Confusion *(Critical)*
- **Where:** `voice-agent-console.html` lines 54 & 117 (`apiUrl: 'https://dialer.example.com/agc/api.php'`).
- **What's wrong:** The generated config points everything at `/agc/api.php` while claiming to load lead data and set non-agent dispositions. VICIdial splits this across **two different endpoints**:
  - **`/vicidial/non_agent_api.php`** — Used for backend operations without an agent screen: `lead_field_info` (fetching lead context), `update_lead`, `add_dnc_phone`.
  - **`/agc/api.php`** — Used for active session / Remote Agent call control (`ra_call_control` for `INGROUPTRANSFER`, `EXTENSIONTRANSFER`, `HANGUP`, or `external_transferconf`).
- **How to fix:** Store base `viciBaseUrl` (e.g., `https://dialer.example.com`) and have the bridge hit `/vicidial/non_agent_api.php` for lead/DNC data and `/agc/api.php` for Remote Agent call control.

### 3.3 Broken Ingroup Transfer & AudioSocket Dialplan Assumptions *(Critical)*
- **Where:** `voice-agent-console.html` line 117 (`viciCfg()`).
- **What's wrong:**
  1. **Raw `AMI Redirect` to an Ingroup (`FE_CLOSERS`) does not work:** `FE_CLOSERS` is a VICIdial database ingroup, not an Asterisk dialplan extension. Redirecting an Asterisk channel away from VICIdial's `meetme`/`confbridge` session without VICIdial's AGI/API loses the `V...`/`Y...` CallerID tracking string—meaning live closers won't get the lead screen-pop or proper call recording linkage. Use VICIdial's Remote Agent `ra_call_control` (`stage=INGROUPTRANSFER&ingroup_choices=FE_CLOSERS`) or route through VICIdial's closer `agi-VDAD_ALL_inbound.agi` dialplan.
  2. **Random `uuidgen` breaks call correlation & hurts PBX performance:** `Set(UUID=${SHELL(uuidgen|tr -d '\n')})` spawns a Linux shell on every concurrent call and passes a random UUID over `AudioSocket`. Because Asterisk's `AudioSocket` TCP protocol *only* transmits that 16-byte UUID + raw PCM audio (no SIP headers, no CallerID, no `lead_id`), the Bridge has **no way to know which VICIdial lead is speaking** unless the dialplan first notifies the bridge via HTTP/AGI/AMI or encodes/maps `${CALLERID(name)}` (which carries VICIdial's `VmmddhhmmssLLLLLLLLL` lead ID) to that UUID.
  3. **Wrong config filename:** `extensions-custom.conf` is a FreePBX convention. On ViciBox/VICIdial, custom dialplans belong in **Admin → System Settings → Custom Dialplan Entry** (or Carrier/Server dialplan entries) so `ADMIN_keepalive_ALL.pl` manages it cleanly.
  4. **Asterisk version compatibility:** Many production ViciBox servers run Asterisk 13 or 16 without `app_audiosocket.so` compiled. If your ViciBox lacks `AudioSocket`, connecting your Node bridge as a **SIP Trunk / Remote Agent SIP Peer** (via Drachtio, LiveKit SIP, or FreeSWITCH/PJSIP) works on **100% of VICIdial versions** with zero changes to Asterisk modules.

### 3.4 Campaign Settings Are Not Wired Into Agent Behavior or Multi-Campaign Routing *(High)*
- **Where:** `voice-agent-console.html` lines 53, 111, 117.
- **What's wrong:**
  - Filling in `Recording disclosure` (*"This call may be recorded..."*) or `Dispositions` (`XFER,NI,DNC...`) on a Campaign **never updates** the linked Agent's greeting, system prompt, or `set_disposition` enum schema.
  - `viciCfg()` only outputs comments for whichever single campaign is currently selected in the Campaigns dropdown (`C()`), ignoring all other campaigns.

---

## 4. Deepgram Voice Agent API Schema Audit

Comparing `settings(a)` (lines 72–83) against Deepgram's current Voice Agent API documentation:

1. **Managed Google Gemini Falsely Flagged as Error + BYO Google Bug (`lines 77, 92`):**
   - Pre-flight check `ok(!['google','groq','aws_bedrock'].includes(lp.type)||!!lp.endpoint, ...)` marks `google` without an endpoint as an **Error (`✗`)**. Deepgram natively manages `google` Gemini models (`endpoint` is optional; only `groq` and `aws_bedrock` require `endpoint`).
   - Conversely, when a custom BYO `google` endpoint *is* provided, Deepgram's API rejects `think.provider.model` (the model must be in the URL instead), whereas `settings(a)` always sends `model`.
2. **Incomplete Cartesia & ElevenLabs Presets (`lines 42–43, 81–82, 92`):**
   - **Cartesia (`t3`):** Default `endpoint` is empty `""`, so its `X-API-Key` header is silently dropped from `Settings`, while `extra` hardcodes invalid voice ID `"VOICE_ID"`. Also, Deepgram offers *managed* Cartesia (no `endpoint` required) as well as *BYO* Cartesia (`https://api.cartesia.ai/tts/bytes`), which `checks(a)` conflates.
   - **ElevenLabs (`t2`):** Preset `extra` uses `{"language":"en"}` and leaves `endpoint` blank (`wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/multi-stream-input` is required for Turbo v2.5, or HTTPS for `eleven_v3`, with `language_code`).
3. **Custom STT Plug-ins Allowed When Deepgram Only Supports `deepgram` (`lines 109, 144`):**
   - Clicking `+ Add STT plug-in` creates `type: "custom"`. Deepgram's Voice Agent API `agent.listen.provider.type` **only supports `"deepgram"`**; sending anything else fails immediately, and `checks(a)` does not validate `sp.type === 'deepgram'`.
4. **Unvalidated Parameter Ranges & Increments (`lines 70, 81, 88`):**
   - All numeric inputs use `step="any"`. Deepgram rejects Flux TTS `speed` values not in `0.05` increments (`0.5–1.5`), non-integer `expressivity` (must be `-2, -1, 0, 1, 2`), Aura `speed` below `0.7`, or Flux STT `eot_threshold` outside `0.5–1.0` / `eager_eot_threshold` outside `0.3–0.9`.

---

## 5. Frontend / UI Bugs Found in `voice-agent-console.html`

Because the HTML file was never opened or clicked through in a browser after generation, these UI/state bugs exist right now:

1. **Adding 2+ Functions Collides on ID & Renaming Orphans Agents (`lines 35, 107, 130, 144`):**
   - `+ Add function` hardcodes `id: "f_new_function"` every time. Adding two functions creates duplicate IDs, breaking `Save & verify` diffing.
   - Agents store enabled functions by **name** (`a.fns = ['set_disposition', ...]`) rather than `id`. Editing a function's name in the Plug-ins tab immediately unchecks/drops that function from every agent using it.
2. **Viewing the Testing Tab Triggers Fake "Unsaved Changes" (`line 113`):**
   - For any newly created agent, clicking the **Testing** tab runs `S.tests[a.id] = S.tests[a.id] || []` inside `view()`, mutating `S` during render and lighting up `● Unsaved changes` without the user touching anything.
3. **Editing Any Number Input Converts Numbers to Strings (`line 158`):**
   - `set(t.dataset.p, t.value)` writes strings (`"8000"`, `"3"`, `"0.7"`) into state `S`. Campaign JSON and Export JSON end up mixing strings and numbers, and changing `3` → `4` → `3` leaves `● Unsaved changes` stuck because `"3" !== 3`.
4. **Weak JSON Validator `J()` Allows Corrupted `Settings` (`lines 33, 76, 78, 93`):**
   - Clearing a function's parameters outputs `"parameters": {}` (missing `"type": "object"`), while entering a JSON string like `"test"` in `Extra provider fields JSON` passes pre-flight validation (`✓`) and spreads `"0":"t","1":"e"...` into the Deepgram payload.
5. **Export Overwrites Duplicate-Named Agents & Lacks File Download/Import (`lines 123, 147, 150`):**
   - Clicking `+ New` creates agents named `"Untitled"`. Export builds `settings` using `Object.fromEntries(S.agents.map(a => [a.name, settings(a)]))`—so multiple `"Untitled"` (or identically named) agents silently overwrite one another.
   - Export only has `Copy JSON` and an unconfirmed `Reset to defaults` (which also leaves stale `cur.a`/`cur.c` IDs); there is no `.json` file download or import button, and Plug-ins can be deleted down to zero without guards.

---

## 6. Recommended Next Steps (Action Plan to Reach Production)

To move from this static HTML mockup to a working **Console + Deepgram Voice Catalog + Live Bot Tester + VICIdial Bridge**, build it as **one unified Node.js (TypeScript) service**:

### Step 1: Backend Server + Deepgram Real Voice Catalog (Solves Your Last Question in Claude)
- Host the console via an Express/Fastify server with `.env` holding `DEEPGRAM_API_KEY` (and optional ElevenLabs/Cartesia keys) + SQLite/JSON file persistence on disk so settings survive across browsers and team members.
- Add `GET /api/deepgram/voices` (calling Deepgram's `/v1/models` endpoint) and `POST /api/tts/preview` so the **Voice Lab** lists every real Deepgram Aura & Flux voice with language/accent filters, plays **real Deepgram TTS audio** of your greeting, and has a **"Set as Agent Voice"** button.
- Fix all 13 UI & Deepgram schema bugs identified in Sections 4 & 5.

### Step 2: Live Browser Microphone Testing ("Talk to Bot")
- Before connecting VICIdial, add a **Live Call Simulator** in the **Testing** tab: stream your browser mic/speaker over WebSocket to your Node backend → Deepgram Voice Agent API (`wss://agent.deepgram.com/v1/agent/converse`).
- Display real-time STT transcripts, LLM replies, latency metrics, and triggered function calls (`transfer_to_live_agent`, `set_disposition`, `end_call`) so you can verify bot behavior live in 30 seconds.

### Step 3: VICIdial Bridge Service
- **Confirm two quick facts on your VICIdial server** before coding the telephony leg:
  1. Run `asterisk -rx "core show version"` and `asterisk -rx "module show like audiosocket"` on your ViciBox dialer (determines whether to use **AudioSocket** or a **SIP Trunk / Remote Agent** leg—SIP Trunk is often cleaner on VICIdial because CallerID lead metadata arrives natively in SIP headers!).
  2. Confirm whether the Node bridge will run on a **separate VPS/server** (recommended so Node/TLS/WebSockets don't compete with Asterisk CPU on ViciBox) or on the same machine.
- Implement the bridge call lifecycle:
  1. Receive call from VICIdial Remote Agent → extract `lead_id` from VICIdial CallerID string.
  2. Query `/vicidial/non_agent_api.php?function=lead_field_info` → inject lead details + Campaign Recording Disclosure into the prompt.
  3. Stream bidirectional 8 kHz audio with Deepgram Voice Agent API.
  4. Execute `transfer_to_live_agent` via `/agc/api.php` (`ra_call_control` `INGROUPTRANSFER` / closer AGI) so live closers get full lead screen-pop, and push `set_disposition` / `DNC` updates automatically.
