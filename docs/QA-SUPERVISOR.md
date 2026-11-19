# Sentinel — Supervisor & Quality Control

Sentinel (`a_qa`) is one QA review bot shared by every campaign. It audits a call
transcript or a quote-bearing call summary, applies a consistent 100-point
standard, detects critical compliance failures, coaches operators, and gives a
release decision.

**Code:** [`src/sentinel-qa.ts`](../src/sentinel-qa.ts)  
**Campaign access:** added to the `agentIds` pool of every campaign, but **never**
the primary telephone agent. `acceptViciCalls` is `false`, so Sentinel cannot
take a live VICIdial call.

## What Sentinel can and cannot do

Sentinel is a review agent, not an autonomous call monitor.

- **Can:** audit a supplied transcript/summary, score six dimensions, quote
  evidence, flag critical violations, produce coaching and a machine-readable
  report.
- **Cannot:** fetch recordings by itself, listen to live calls, set dispositions,
  transfer prospects, change configuration, or give legal advice.

If there is no quote-bearing evidence, Sentinel returns `INSUFFICIENT EVIDENCE`.
That guardrail prevents a fabricated score.

## How to avoid INSUFFICIENT EVIDENCE

### 1. Use the text box, not only the microphone

Start a **Browser Test**, choose any campaign and **Sentinel — Supervisor &
Quality Control**, then type into the message box under the live feed. The
console injects that text into the same Deepgram conversation.

### 2. Chunk long transcripts

Each injected turn is capped at 8,000 characters. Split the transcript and label
the parts:

```text
EVIDENCE PART 1/2
Campaign: Medicare Food & OTC
Bot: a_medicare
Call ID: QA-001
Disposition: XFER

Agent: This call may be recorded.
Caller: That's fine.
Agent: Do you have Medicare Part A or Part B?
Caller: I have both.
MORE EVIDENCE FOLLOWS
```

```text
EVIDENCE PART 2/2
Agent: Wonderful. Let me connect you with a specialist.
Caller: Okay.
END OF EVIDENCE — give me the full scorecard.
```

Sentinel acknowledges each part and waits for `END OF EVIDENCE` before scoring.

### 3. Minimum packet when there is no full transcript

Include exact quotes for:

1. Campaign and bot.
2. Call ID/date/duration and disposition.
3. Opening and required disclosure.
4. Caller stop, DNC, refusal or opt-out.
5. Agent claims, prices, guarantees or promises.
6. Qualification questions and answers.
7. Transfer consent and whether a transfer actually happened.
8. Ending and next step.

Then add: `EVIDENCE IS PARTIAL — give me a LIMITED REVIEW.` Sentinel scores only
the demonstrated dimensions, marks unsupported dimensions `N/A`, and lowers
confidence instead of refusing.

### 4. Policy question without a call

```text
Policy question: may the Medicare bot ask age after the caller confirms Part A and Part B?
```

This is answered in **POLICY** mode, not `INSUFFICIENT EVIDENCE`.

### 5. Transcript too long for the console

Use `src/sentinel-qa.ts`'s `SENTINEL_QA_AGENT.prompt` in any text LLM: paste the
prompt first, then the evidence packet. The same critical-evidence rules apply.

## 100-point standard

| Dimension | Weight |
|---|---:|
| Compliance & Consent | 30 |
| Honesty & Accuracy | 20 |
| Respect, Empathy & Clarity | 15 |
| Conversation Control | 10 |
| Process & Outcome | 15 |
| Privacy & Data Handling | 10 |

Any critical red flag — DNC ignored, a guarantee, government misrepresentation,
SSN/MBI/bank request, fabricated action, deliberate identity deception where
disclosure is required, or a missing required disclosure — makes the verdict
`FAIL`, caps the score at 59, and requires human compliance review.

Verdicts: `PASS`, `CONDITIONAL`, `FAIL`, `INSUFFICIENT EVIDENCE`.  
Release decisions: `RELEASE`, `RELEASE WITH COACHING`, `HOLD FOR COMPLIANCE`,
`INSUFFICIENT EVIDENCE`.

## Campaign policy packs

| Campaign | Bot | Key checks |
|---|---|---|
| Final Expense `c1` | `a1` | 50–85 screen, no price/underwriting guarantees, consent before transfer, DNC |
| Medicare Food & OTC `c_medicare` | `a_medicare` | A/B confirmation is sufficient, no age question after Medicare, no government affiliation, no MBI/SSN, `LANG` exit |
| Nova `c_nova` | `a_nova` | Accurate general Q&A, honest uncertainty, consent-based transfer, DNC |
| Jessica `c_med_fronter` | `a_jessica` | Transparent automated identity, no government/CMS affiliation, no SSN/MBI/bank, DNC |
| Build-In `c_builtin` | `a_builtin` | Accurate answers, honest tool claims, consent-based transfer, DNC |

## Tests

`tests/qa-bot-verify.ts` checks that Sentinel exists in the defaults and static
demo, every campaign can select it, it is never a primary dialling agent, the
chunked-evidence and limited-review instructions are present, and every composed
prompt fits the console's 24,950-character limit.

```bash
node tools/run-tests.js qa-bot
```
