# Campaign readiness, opening, and mock audio test results

- **Date:** 2026-11-08
- **Build:** `elite-2.31`
- **Scope:** removal of the automatic presence-check/dead-air timeout/disposition/hangup path; mock-call audio streaming and agent-speaking verification; one-second configured opening, comfort-silence keep-alive, campaign readiness and bridge regression checks.

## Current results (`elite-2.31`)

| Check | Result | What was exercised |
| --- | --- | --- |
| `npm run build` | Passed | TypeScript compilation and generated `dist/` output. |
| `CI=true npm test` | Passed; one live Deepgram E2E skipped | Full offline Node suite, including the new `mock-audio` suite. No live provider, carrier, VICIdial or Asterisk connection was used. |
| Mock Live Bot WebSocket | Passed | Exact caller PCM forwarded before/after settings; exact provider PCM returned; comfort-silence keep-alive; configured opening after the one-second listen; `listening → speaking → listening`; continued silence without hangup; explicit hangup and saved transcript with no disposition. |
| Static browser mock playback | Passed in JSDOM | PCM16 conversion and WebAudio scheduling, speaking/listening UI, manual barge-in stopping queued playback, stale-audio suppression, new-turn playback and audio cleanup. This is not a physical microphone/speaker test. |
| Bridge opening and call-control integration | 14 local scenarios passed | AudioSocket and SIP/RTP each covered silent opening, early caller, cancellation, provider refusal, silent wait without automatic hangup/disposition, disallowed disposition, and DNC-to-transfer blocking. The silent-wait case stayed connected beyond the retired minimum timeout and ended only on explicit operator hangup. |
| Dead-air removal | Passed | Runtime gate, simulator, bridge, campaign UI/validation/export, prompts and shipped defaults no longer contain the automatic silence path. Legacy saved fields are ignored/stripped without blocking readiness. |
| `npm audit --audit-level=low` | Passed; 0 vulnerabilities reported | Current Node lockfile. |
| Chromium browser audit | Not rerun | Chromium/system libraries are unavailable in this workspace. The checked-in Playwright audit expectations were updated; JSDOM mock playback above was executed. |

### Behavior now

1. Provider settings are acknowledged, then caller audio continues upstream during a one-second listen.
2. If the caller completes a turn first, the agent answers that turn and no extra opening is injected.
3. If the line is silent, the configured opening is injected once. An unfinished VAD onset gets a bounded transcription grace period before the same opening is released.
4. After the opening, silence does not retry the prompt, apply a disposition, or hang up. Comfort-silence PCM and provider keep-alives continue until the caller responds, the agent explicitly ends the call, or the operator/transport hangs up.
5. Explicit disposition, transfer, DNC and `end_call` behavior remains subject to the existing campaign and browser-test safety checks.

### Limits

These are synthetic/local mock tests. They verify transport bytes, protocol events, timing gates and browser scheduling, not intelligible speech from a real TTS provider or what a person heard through a physical speaker. A live Deepgram key, real browser audio permission and an authorized telephone/PBX test are still required for live validation. GitHub Pages hosts the static interface only; it does not run the Node bridge.

## Historical results (`elite-2.25`, superseded)

The previous build used a presence-check/dead-air flow. That flow has been removed and the results below are retained only as history.

| Check | Result | What was exercised |
| --- | --- | --- |
| `node --check public/app.js` | Passed | Browser bundle syntax. |
| `npm run build` | Passed | TypeScript compilation and generated `dist/` output. |
| `npm test` | Passed; one live Deepgram E2E skipped | Full offline Node suite at that time. |
| Bridge opening/disposition integration | 14 local scenarios passed | Included the now-retired dead-air update failure and Remote Agent hangup status behavior. |
| External services | Not used | Synthetic/local fixtures only. |
| `npm audit --audit-level=low` | Passed; 0 vulnerabilities reported | Dependency audit for the lockfile at that time. |
| Browser/Python audits | Not rerun for that build | Older `elite-2.24` checks remain historical below. |

## Historical opening validation (`elite-2.24`, 2026-11-06)

The following checks were run on the previous build and are retained as historical evidence only.

| Check | Result | What was exercised |
| --- | --- | --- |
| `npm run build` | Passed | TypeScript compilation and committed `dist/` output. |
| `npm test`, native `better-sqlite3` | 83 groups passed; 1 live Deepgram test skipped | Full Node suite with SQLite 3.51.2. |
| `npm test`, `node:sqlite` fallback | 83 groups passed; 1 live Deepgram test skipped | Full Node suite with the native addon temporarily hidden. Node 22 emitted its experimental SQLite warning. |
| `python3 tools/build-greetings.py --check` | Passed | Both generated catalogs match the 1,100-row source CSV. |
| `audit/browser-smoke.cjs` | 28 checks passed | 860 rendered control instances, no unlabelled inventoried form fields or uncaught page errors, and no document overflow in 27 view/viewport combinations. See `audit/browser-results.json`. |
| `audit/live-bot-browser.cjs` | 19 checks passed | Mock-provider server and direct-browser flows, notice draft, delay, early caller, history and recording/storage behavior. |
| `python -m pytest -q speech-service/tests` | 21 passed, 1 warning | Fake speech-service runtime; existing Starlette/httpx TestClient deprecation warning. |
| `npm audit --audit-level=low`; `pip check` | Passed | No known Node lockfile vulnerabilities reported; no broken Python test-environment requirements. This is not a full production/GPU dependency audit. |
| JS and shell syntax, Python compilation, asset parity, `git diff --check` | Passed | Local source/release hygiene, not live deployment verification. |

Environment: Node 22.22.3, npm 10.9.8, Python 3.11.2, Playwright Core 1.65.0 and headless Chromium 153.0.8010.0. Browser media used fake devices and synthetic PCM; external browser requests were blocked.

### Critical opening checks

- All 1,100 dataset rows were composed with the screenshot-style sample opening. Each result kept the configured identity, had exactly one question, stayed under 145 characters, and did not append the full imported greeting. The rows produced 77 distinct short wordings for that sample. This is not a guarantee that an operator-supplied long or multi-question opening will be shortened.
- Rotation tests covered a complete 1,100-ID cycle, the cycle boundary, independent agents, restart and 75 concurrent selections across processes. A deterministic fixture confirmed that a different short wording is preferred when one is available, while an unavoidable repeated wording does not discard the last unused ID. Static-browser tests covered IndexedDB persistence, simultaneous tabs, cycle boundary and storage/catalog fallbacks.
- The explicit campaign-notice opt-in and opt-out survive reload and remain per agent. A Live Bot draft change affected the next test without silently changing the saved server state. Existing explicit values were preserved; a notice already embedded in a saved opening was not stripped or duplicated.
- Exact old stock Nova and Medicare openings, and the exact old stock Medicare prompt's obsolete “already asked” passage, were migrated. Modified/customized prompts and openings remained unchanged in the migration fixtures.
- Unit tests checked the 500 ms timer, one injection for a silent caller, early audio buffering, early caller priority, interruption, cancellation, bounded early audio and the delayed noise-onset fallback. Local mock Live Bot and direct-browser tests covered a caller turn arriving before release and verified no extra injected opening. Assertions allow 10 ms of clock/scheduling tolerance (`>= 490 ms`); they do not measure a real caller's perceived timing.
- Eight local bridge cases covered AudioSocket and SIP/RTP with a silent caller, an early caller, cancellation and a synthetic provider refusal on each transport. The early caller's synthetic input reached the mock provider during the gate; no duplicate opening was injected. The mock's 200 ms of generated output was delivered in 10 paced frames before hangup. Refusals and warnings were recorded without inventing playback or repeatedly injecting. These tests do not establish remote PBX or network behavior.
- Selected greeting IDs, saved history/CDRs, fallback on library failure, lead placeholder hydration and opt-out were checked with mocks. An ID is a selection record, not evidence that audio played or was heard.

## Reproducing

From the repository root:

```sh
npm ci --include=dev
npm run build
npm test                              # offline by default
python3 tools/build-greetings.py --check
npm audit --audit-level=low
python3 -m venv .venv
.venv/bin/pip install -r speech-service/requirements-test.txt
.venv/bin/python -m pytest -q speech-service/tests
.venv/bin/pip check
```

The Node suite uses `better-sqlite3` when its optional native addon is available and otherwise falls back to `node:sqlite` (Node 22.5+). The historical `elite-2.24` run tested both paths by temporarily hiding the native addon and restoring it afterwards. Some platforms need local compiler tools and Node headers to build the addon.

The browser audits require a separately installed `playwright-core`, a compatible Chromium and its system libraries. Set `NODE_PATH` and `BROWSER_EXECUTABLE` as shown in [audit/README.md](audit/README.md#reproducing-the-browser-smoke), then run `node audit/browser-smoke.cjs` and `node audit/live-bot-browser.cjs`. The smoke command rewrites the checked-in inventory using disposable fixture data.

## Limits and review before real use

- The wait begins when the provider confirms settings, not when a telephone is answered. It is a fixed output hold, **not** a promise that a customer has said or finished “hello.” An early caller is handled by provider turn detection and prompt instructions; LLM wording and timing are not deterministic. The provider may refuse an injection while a turn is active, and output may be delayed or absent. A selected ID or mock timestamp does not prove anyone heard a greeting.
- This implementation sends `InjectAgentMessage` using the `message` field specified by Deepgram's [dedicated injection reference](https://developers.deepgram.com/docs/voice-agent-inject-agent-message). Another [context page](https://developers.deepgram.com/docs/voice-agent-conversation-context) has shown an inconsistent example; the real provider protocol and behavior were not validated in this run. Test with an authorized test account when available.
- Spoken notice settings do not disable recording. Existing choices may be on even though new agents default off. Verify applicable recording disclosure and consent requirements, and review identity and all factual claims before making calls. The example Medicare/Food & OTC scripts and historical blueprint contain **unverified** affiliation, eligibility and benefit claims.
- GitHub Pages hosts the static interface; it does not deploy the Node server or telephony bridge. No production server was modified, and VICIdial configuration and integration remain paused until the operator resumes that work.
