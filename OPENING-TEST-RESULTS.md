# Opening and call-delay test results

- **Date:** 2026-11-06
- **Build:** `elite-2.24`
- **Scope:** single-opening composition, greeting rotation, optional recording notice, and the 500 ms output gate in browser tests and the bridge. All call/provider fixtures used synthetic data, local sockets and mock services. No live customer, Deepgram, carrier, VICIdial or Asterisk connection was used.

## Results

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

The Node suite uses `better-sqlite3` when its optional native addon is available and otherwise falls back to `node:sqlite` (Node 22.5+). This run tested both: the native addon was installed/built, and then temporarily moved out of `node_modules` for the second full run and restored afterwards. Some platforms need local compiler tools and Node headers to build the addon.

The browser audits require a separately installed `playwright-core`, a compatible Chromium and its system libraries. Set `NODE_PATH` and `BROWSER_EXECUTABLE` as shown in [audit/README.md](audit/README.md#reproducing-the-browser-smoke), then run `node audit/browser-smoke.cjs` and `node audit/live-bot-browser.cjs`. The smoke command rewrites the checked-in inventory using disposable fixture data.

## Limits and review before real use

- The wait begins when the provider confirms settings, not when a telephone is answered. It is a fixed output hold, **not** a promise that a customer has said or finished “hello.” An early caller is handled by provider turn detection and prompt instructions; LLM wording and timing are not deterministic. The provider may refuse an injection while a turn is active, and output may be delayed or absent. A selected ID or mock timestamp does not prove anyone heard a greeting.
- This implementation sends `InjectAgentMessage` using the `message` field specified by Deepgram's [dedicated injection reference](https://developers.deepgram.com/docs/voice-agent-inject-agent-message). Another [context page](https://developers.deepgram.com/docs/voice-agent-conversation-context) has shown an inconsistent example; the real provider protocol and behavior were not validated in this run. Test with an authorized test account when available.
- Spoken notice settings do not disable recording. Existing choices may be on even though new agents default off. Verify applicable recording disclosure and consent requirements, and review identity and all factual claims before making calls. The example Medicare/Food & OTC scripts and historical blueprint contain **unverified** affiliation, eligibility and benefit claims.
- GitHub Pages hosts the static interface; it does not deploy the Node server or telephony bridge. No production server was modified, and VICIdial configuration and integration remain paused until the operator resumes that work.
