# Jessica — Medicare Master Training & Compliance

Source: operator-supplied *Medicare AI Agent Jessica Master Training Document.pdf* (8 pages).

Applied to `a_jessica` in `data/console-state.json`: PDF's 10 opening variants, 50 Q&A training topics, and 20 DNC phrases are embedded in Jessica's prompt. Persona/self-introduction and STT keyterms were aligned to Jessica and Senior Care Benefits. Default opening avoids asserting unverified benefit availability.

## Existing campaign gate retained
Jessica is assigned to `c_med_fronter` / `MEDFRONT`, routing to `MED_CLOSERS`. The existing campaign gate requires caller-confirmed Medicare Part A **and** Part B and age 65–85. The PDF includes a 65–100 example; it does not override the stricter existing campaign configuration.

## Compliance safeguards
- Never request SSN, bank/payment information, Medicare MBI, or Medicare card number.
- Never give medical advice or guarantee plan names, availability, allowance amounts, copays, provider networks, utility/rent coverage, or costs.
- Never claim to be Medicare, CMS, government, or a human; disclose automation when asked.
- Do not invent caller consent/source, company location/partnerships, recording status, free/no-cost review, transfer timing, or callback promises.
- Use the campaign's configured recording disclosure only.
- Clear opt-out: DNC + end_call immediately; no rebuttal. Do not claim DNC succeeded unless confirmed.
- Transfer only after the campaign eligibility gate and caller consent.
- Callback-number request: decline and end_call per source.

**Activation note:** This file is the checked-in state seed/mirror. A running installation with an existing SQLite `active_state` does not automatically consume this file. It must import the updated state or receive a migration and reload. No live calls, VICIdial route, carrier settings, or production deployment were changed or tested.
