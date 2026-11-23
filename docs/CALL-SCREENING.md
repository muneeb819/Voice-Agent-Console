# Call screening (answering machine detection)

MMA Digital Labs · Voice Agent Console · November 2026

**What it does:** with screening switched on, no campaign conversation starts until a person has been confirmed. Voicemail, phone menus (IVR), recorded or network announcements and authorised test numbers are hung up with their VICIdial status, and the remote-agent line is released for the next call. Anything the engine cannot confirm is UNCERTAIN, which never reaches the bot.

**Operator controls (console → Vici Bridge → Call screening):**
1. **Turn screening on / off.** Takes effect on the next call; no restart.
2. **Run testing & verification.** Runs every detection scenario through the real engine, then checks Deepgram, the VICIdial API, Asterisk AMD (read-only AMI commands), and whether the last 24 hours of dispositions were confirmed in VICIdial.

Owners and admins can use both buttons; other roles see the status only.

---

## 1. Architecture

```
 Customer ──► VICIdial / Asterisk
                │  campaign Routing Extension 8370 (MMA) instead of 8369 (stock)
                │  8370 = copy of 8369 + one step after AMD():
                │     MACHINE ─► stock VD_amd.agi hangs up with AA (unchanged)
                │     HUMAN / NOTSURE ─► result stored in AstDB  MMA_AMD/<caller code>
                ▼
           Remote-agent leg to the AI extension (88xxx)
                │  relays MMA_AMD as SIP header X-MMA-AMD (+ X-MMA-AMD-Sig)
                │  or as amd= / amd_sig= on the pre-call hook (AudioSocket)
                ▼
 Voice Agent Console bridge (SIP/RTP or AudioSocket, 8 kHz PCM already decoded)
                │
                ├─► Screening module  (src/screening/, independent of the bot)
                │     audio analyzer: voice activity, beep, SIT tones, noise floor
                │     Deepgram streaming speech-to-text (listen only)
                │     phrase rules: voicemail, IVR / call-screening assistants, announcements
                │     optional "Hello?" probe for interactive verification
                │     decision engine ─► one of 6 outcomes
                │
                ├─ HUMAN_CONFIRMED ─► Deepgram Voice Agent session opens; bot greets at once
                └─ anything else   ─► ra_call_control HANGUP with the status (once),
                                      read back via callid_info + lead_all_info,
                                      resources released, VICIdial dials on
```

Design choices:

- **The bridge is the anchored media gateway.** Customer RTP already terminates on the bridge and is decoded once to 8 kHz linear PCM. Screening reads that same PCM: no extra RTP leg and no extra transcoding.
- **Two independent stages.** Native AMD (Asterisk) filters obvious machines cheaply. The AI screening checks every call that reaches the bot, whatever native AMD said, and native NOTSURE always goes to it.
- **Fail closed.** HUMAN_CONFIRMED needs a recognised short answer from speech-to-text. An outage, a timeout, a stalled stream or any internal error ends as UNCERTAIN, never as a person.
- **No VICIdial database writes from Node.js.** Statuses go through the Agent API (`ra_call_control`). Results are read back through the Non-Agent API (`callid_info`, `lead_all_info`). The shell scripts query the database read-only, only to inspect.
- **The stock dialplan is never edited.** 8370 is generated next to 8369, and `VD_amd.agi` is not modified or overwritten.

## 2. Decision engine

The checks run in this order; the first match decides.

| # | Evidence | Outcome |
|---|---|---|
| 1 | Phone number on `SCREENING_TEST_ENDPOINTS` | KNOWN_TEST_ENDPOINT |
| 2 | Native AMD = MACHINE with a valid signature | VOICEMAIL |
| 3 | Special information tones (~914/985 Hz then ~1371/1429 Hz) | PRERECORDED_AUDIO |
| 4 | Steady single tone 400–2100 Hz, ≥ 200 ms (voicemail beep) | VOICEMAIL |
| 5 | Words: "number you have dialed / not in service / recorded message …" | PRERECORDED_AUDIO |
| 5 | Words: "press 1 / para español / main menu / screening service / say your name …" | IVR |
| 5 | Words: "leave a message / after the tone / not available … / you've reached …" | VOICEMAIL |
| 6 | First utterance ≥ 3.5 s with no pause | VOICEMAIL |
| 7 | Short answer (≤ 3 s, 1–8 recognised words, final transcript), then ≥ 0.8 s of quiet | HUMAN_CONFIRMED |
| 8 | No speech by 2.5 s, or sound without words: play "Hello?" once; a short recognised reply | HUMAN_CONFIRMED |
| 9 | No reply within 3 s of the probe, or 7 s reached | UNCERTAIN |

Time is measured in caller audio received, so network jitter cannot fake silence. A wall-clock backstop (screening limit + 3 s) ends a call whose audio stops arriving.

Background noise is not counted as speech: the noise floor adapts, and spectrally flat sound is rejected.

## 3. Configuration

The on/off switch is stored in the database and set from the console. Every other setting is optional, in `/opt/voice-agent-console/.env`.

| Variable | Default | Meaning |
|---|---|---|
| `SCREENING_EVENT_SECRET` | empty | Signs the native AMD result; must match `install-mma-amd.sh --secret`. Without it, AMD headers are trusted only because SIP is accepted from `BRIDGE_ALLOWED_IPS` alone. |
| `SCREENING_TEST_ENDPOINTS` | empty | `3055550100=Carrier test,3055550111` |
| `SCREENING_DISPO_VOICEMAIL` / `_IVR` / `_PRERECORDED` / `_TEST_ENDPOINT` | AA | VICIdial status per outcome (must exist in VICIdial) |
| `SCREENING_DISPO_UNCERTAIN` | NA | Status for unconfirmed calls, so the lead is recycled |
| `SCREENING_MAX_MS` | 7000 | Hard cap on screening (3000–15000) |
| `SCREENING_PROBE`, `SCREENING_PROBE_TEXT`, `SCREENING_PROBE_VOICE` | 1, "Hello?", aura-2-thalia-en | Interactive verification line |
| `SCREENING_ALWAYS_PROBE` | 0 | 1 = ask the probe on every call before confirming |
| `SCREENING_ASR_MODEL` | nova-3 | Deepgram model for screening |
| `SCREENING_AMD_CONTEXT` | default | Context of 8369/8370 for the verification checks |
| Fine thresholds | see `src/screening/config.ts` | `SCREENING_AFTER_GREETING_SILENCE_MS`, `SCREENING_LONG_GREETING_MS`, … |

## 4. Data (SQLite, created automatically; no manual migration)

| Table | Purpose |
|---|---|
| `screening_settings` | The single on/off row, with who changed it and when |
| `screening_results` | One row per screened call (primary key = call ID): outcome, reason, native AMD, decision time, evidence, the status sent, disposition state (`pending → sending → sent → verified / mismatch / unverifiable / failed`), and the statuses read back. The phone is stored as its last 4 digits only. |
| `screening_test_runs` | Every Testing & Verification report |

Idempotency: the result insert is `INSERT OR IGNORE`, so a duplicate event changes nothing. The status is sent only by whoever wins the atomic `pending → sending` claim. Call IDs, campaign IDs and status codes are validated before any write.

## 5. Production deployment

1. **Console** (outside calling hours): `git pull && sudo bash deploy/linux-deploy.sh --ip 54.79.152.235`. Screening stays **off** after the update.
2. **Secret:** add `SCREENING_EVENT_SECRET=<32+ random characters>` to `/opt/voice-agent-console/.env`, then run `sudo systemctl restart voice-agent-console`.
3. **Dialer: inspect** (read-only): `sudo bash deploy/vicidial-amd/inspect-amd.sh`. Confirm the following:
   - `app_amd` and `func_sha1` are loaded;
   - 8369 has an `AMD()` step;
   - `VD_amd.agi` hangs up only on MACHINE;
   - the AA status exists.
4. **Dialer: install 8370**:
   - First a dry run: `sudo bash install-mma-amd.sh --tuned --secret '<same secret>'`. Review the printed file.
   - Then apply: add `--apply` to the same command.
5. **AI-extension dialplan:** in the console, Vici Bridge → copy the regenerated dialplan into Asterisk. It now relays `MMA_AMD`; the relay lines are harmless when there is no value. Then run `asterisk -rx "dialplan reload"`.
6. **One campaign first:** in VICIdial admin → Campaign → Routing Extension, change it to `8370`.
7. **Console:** Vici Bridge → Call screening → **1. Turn screening on**, then **2. Run testing & verification**. Everything should pass. "Signed native AMD results" passes once the secret is set.
8. **Watch** 20–30 live calls on the Wallboard. Each transcript starts with the screening lines (native AMD result, what was heard, the decision and its reason). Then roll out to the other campaigns.

## 6. Rollback

Each stage can be undone separately, in seconds:

- **AI screening only:** Call screening → **Turn screening off**. The next calls go straight to the bot, as before.
- **Native AMD (MMA):** set each campaign's Routing Extension back to its previous value (for example 8369), then run `sudo bash deploy/vicidial-amd/rollback-mma-amd.sh`. The script refuses while any campaign still uses 8370. It then removes the include, the generated file and the cleanup job, and reloads the dialplan. A backup of `extensions.conf` is kept.
- **Code:** redeploy the previous version (`git checkout <previous> && sudo bash deploy/linux-deploy.sh --ip …`). The screening tables are left unused and do no harm.

## 7. Tests

`npm test` includes `tests/screening-verify.ts` (85 checks). The engine scenarios are listed in section 8; on top of them the suite covers:

- **Safety:** errors, outages, interim-only transcripts and stalled audio are never confirmed as a person.
- **SIP disconnect** during screening.
- **Duplicate events**, duplicate cancels and duplicate disposition claims.
- **Invalid IDs:** call IDs, campaign IDs and status codes.
- **AMD header signatures:** a signature from another call or a forged one is rejected.
- **Disposition handling:**
  - sent once, retried on a temporary error;
  - `failed`, `mismatch` and `unverifiable` states;
  - a hang-up is never assumed to mean AA.
- **Full bridge path, with local fixtures:**
  - screening off leaves the call flow unchanged;
  - voicemail: the bot never starts, exactly one HANGUP with AA, then the call log and lead are read back and marked verified;
  - person: the bot starts after confirmation and receives none of the screening audio;
  - hang-up during screening: no AA.

## 8. QA acceptance report (23 November 2026)

| Suite | Result |
|---|---|
| Full regression (`npm test`, 27 suites incl. call screening) | All passed |
| Call screening suite | 85 / 85 checks |
| Detection scenarios (also run by the console button) | 18 / 18 |
| Shell scripts (`bash -n`, `shellcheck -S warning`) | Clean |
| Installer dry run against a captured 8369 dialplan | 8370 generated correctly: stock steps kept, `${EXTEN}` pinned to 8369, AMD result stored after `AMD()`, secret masked in the printout |
| Console UI (Chrome, 1366 px and 400 px) | Card renders, both buttons work, no script errors, no sideways scroll |

Detection scenarios, decision and decision time (audio clock):

| Scenario | Expected | Decision |
|---|---|---|
| Human "Hello?" then waits | HUMAN_CONFIRMED | 2.1 s |
| Human "Yeah, hello" on a noisy line | HUMAN_CONFIRMED | 2.5 s |
| Voicemail greeting | VOICEMAIL | 3.2 s |
| Long recorded greeting, no words recognised | VOICEMAIL | 3.8 s |
| Voicemail beep | VOICEMAIL | 1.0 s |
| IVR menu | IVR | 2.0 s |
| Phone call-screening assistant | IVR | 2.3 s |
| SIT tones (network announcement) | PRERECORDED_AUDIO | 0.5 s |
| Prerecorded message | PRERECORDED_AUDIO | 2.4 s |
| Silence, probe unanswered | UNCERTAIN | 6.0 s |
| Background noise only | UNCERTAIN | 6.0 s |
| Sound without recognisable words | UNCERTAIN | 6.7 s |
| Silent, then answers the probe | HUMAN_CONFIRMED | 4.6 s |
| Speech-to-text outage | UNCERTAIN | 7.0 s |
| Native AMD MACHINE (signed) | VOICEMAIL | 0.0 s |
| Unsigned MACHINE header (ignored) | HUMAN_CONFIRMED | 2.1 s |
| Native AMD NOTSURE | HUMAN_CONFIRMED | 2.1 s |
| Authorised test number | KNOWN_TEST_ENDPOINT | 0.0 s |

**Not yet verified, because it needs the production dialer:**
- live AMD results from Asterisk on your carrier;
- that the VICIdial caller code is the same on the customer leg and the remote-agent leg (the AstDB relay key depends on it; `inspect-amd.sh` and the first live calls confirm it);
- detection accuracy on real voicemail greetings.

Measure accuracy on the first live calls with recordings. Then tune `SCREENING_LONG_GREETING_MS` and `SCREENING_MAX_HUMAN_GREETING_MS` if people are marked UNCERTAIN, or voicemails reach the bot.

## 9. Known limits

- **Added time:** screening adds about 2 s before the bot greets a person. The greeting then plays at once, without the usual wait for hello.
- **Carriers that send no audio:** silence ends as UNCERTAIN (status NA), so these leads are retried, not lost.
- **Header relay:** the X-MMA-AMD header path uses `chan_sip` `SIPAddHeader`. With PJSIP, use the AudioSocket pre-call hook, or the AI screening alone (native AMD still hangs up machines on the dialer).
- **Phrase rules are English and Spanish menu cues;** extend `src/screening/transcript-rules.ts` for other languages.
