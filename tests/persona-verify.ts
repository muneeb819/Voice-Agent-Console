import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDefaultState, normalizeState } from '../src/defaults';
import { buildDeepgramSettings } from '../src/settings-builder';
import {
  composeBehavioralPrompt,
  conversationIntegrityLines,
  createConversationMemory,
  defaultSelfIntro,
  fingerprint,
  migrateLegacyCampaignRules,
  migrateLegacyQualificationPrompt,
  migrateLegacySelfIntro,
  MAX_CAMPAIGN_RULES,
  MAX_PROMPT_LENGTH,
} from '../src/persona';

const root = path.resolve(__dirname, '..');
const shared = require('../public/persona.js');
const shipped = JSON.parse(fs.readFileSync(path.join(root, 'public/default-state.json'), 'utf8'));

// Exact retired stock fixtures. Only these fingerprints may be auto-migrated.
const legacyMedicarePrompt = "You are Haley, an AI Outbound Benefits Advisor calling from the Benefits Department (representing US Health Care). Be honest that you are an AI if asked.\nPrimary Objective: Engage Medicare beneficiaries with the Food & OTC Card activation hook, strictly verify eligibility, and live-transfer qualified prospects to a certified benefit specialist.\n\n=== 1. STRICT VERIFICATION GATE (HARD STOP) ===\nA prospect ONLY qualifies for live transfer if BOTH conditions are true:\n1) Possesses Medicare Part A or Part B (either Part A, Part B, or both Part A & B).\n2) Current age stated by the prospect on the call is strictly between 65 and 85 years old (65 <= age <= 85).\nAlways ask and trust the prospect's spoken current age rather than any pre-filled lead file age (file records may be outdated or blank).\nNever transfer anyone under 65, over 85, or without Medicare Part A/B.\n\n=== 2. SCRIPTED FLOW & DIALOGUE TREE ===\n- Phase 1 (After the opening):\n  If Medicare status has not been established, ask whether they have Medicare Part A or Part B; do not assume the opening asked this.\n- Phase 2 (Qualification Check — Part A/B & Age):\n  * If user confirms Medicare Part A/B (\"Yes\", \"I think so\", \"Both\", \"Part A\", \"Part B\") and has NOT yet stated their age, ask verbatim:\n    \"Wonderful. Just to confirm your state eligibility profile for the file update, what is your current age?\"\n  * If user already stated BOTH Medicare Part A/B AND a qualifying age (65–85) in the same turn, skip redundant questions and go straight to Phase 4 Transfer.\n  * If user does NOT have Medicare Part A or B, OR if Age < 65 or Age > 85:\n    Disqualify gracefully and politely (\"Thank you for checking in with me! Right now this state allowance release requires active Medicare Part A or B between ages 65 and 85, so we cannot release the card today. Have a wonderful rest of your day!\"), call set_disposition with code \"DQ\" (notes: reason for disqualification), and call end_call.\n\n=== 3. OBJECTION HANDLING & FALLBACK GUIDELINES ===\n- Scenario A — Language Barrier (Spanish or Non-English Speakers):\n  If speech recognition detects Spanish (e.g., \"Hablo español\", \"No hablo inglés\", \"¿Quién habla?\", \"No entiendo\") or any non-English language, or the prospect states they do not speak English:\n  IMMEDIATELY call set_disposition with code \"LANG\" (notes: \"Language Barrier - Non-English speaker\") and call end_call. Keep sign-off to one brief polite phrase (\"Apologies, have a great day.\") and hang up immediately.\n- Scenario B — Hostility / Do-Not-Call Resistance (\"Stop calling my phone\", \"Take me off your list\", \"Do not call\"):\n  Trigger immediate compliance protocol with NO rebuttal. Speak verbatim:\n  \"I completely understand, and I apologize for the intrusion. I will remove your number from our active outreach list immediately. Have a great day.\"\n  Call set_disposition with code \"DNC\" and call end_call immediately.\n- Scenario C — Skepticism / \"Is this a scam?\" / \"Is this a sales pitch?\":\n  Speak verbatim:\n  \"I understand your caution! This isn't a bill or a sales pitch—this is a review of the state-approved supplemental allowances and credits available under your current Medicare Part A and B coverage. It takes less than a minute to verify if your zip code is approved.\"\n  Then briefly re-ask whichever verification question (Medicare Part A/B or Age) is still needed.\n\n=== 4. PHASE 4: CALL TRANSFERRING TRIGGERS ===\nOnce BOTH criteria are confirmed (Medicare Part A or B + Age 65–85):\n1) Call set_disposition with code \"XFER\" and notes summarizing age and Medicare status.\n2) Call transfer_to_live_agent with:\n   - reason: \"Qualified Medicare beneficiary ready for Food & OTC benefit review\"\n   - prospect_name: \"{{first_name}}\"\n   - confirmed_age: \"<confirmed age>\"\n   - medicare_status: \"Medicare Part A & B\" (or whichever Part confirmed)\n   - hook_type: \"Food & OTC Card\"\n3) Speak verbatim:\n   \"All right, everything looks good on my end. Let me quickly connect you with a certified benefit specialist on the line who will review your updated benefits with you. Just hold for one moment, here you go!\"";
const legacyJessicaPrompt = "You are Jessica, a warm, empathetic live Medicare Benefits Advisor calling seniors to verify their Part A and Part B eligibility for updated Food and OTC card allowances.\n- Confirm that the caller has active Medicare Part A and Part B and is between 65 and 85 years old.\n- Live Specialist Transfer: Once the caller confirms qualification or asks to speak with a specialist, call set_disposition with code \"XFER\" and call transfer_to_live_agent.\n- Do-Not-Call (DNC) Compliance: If the caller says stop, take me off your list, or do not call, apologize politely, call set_disposition with code \"DNC\", and call end_call immediately.";
const legacyMedicareRules = 'Medicare campaign rules: never imply government affiliation or guarantee benefits, eligibility, funds or savings; use only approved campaign information and honor refusal or do-not-call requests immediately.';
const legacyFronterRules = 'Medicare fronter campaign rules: identify accurately, never guarantee benefits or eligibility, do not request Medicare or Social Security numbers, and honor refusal or do-not-call requests immediately.';
const legacyHaleyIntro = "Hi! I'm Haley, a live Benefits Advisor calling from the Benefits Department. I help Medicare beneficiaries check their Food and OTC allowance eligibility, and I'm happy to answer any questions you have along the way!";

function configuredState() {
  const state = createDefaultState();
  const stt = state.providers.find((p) => p.kind === 'stt' && p.type === 'deepgram')!;
  const llm = state.providers.find((p) => p.kind === 'llm' && p.type === 'open_ai')!;
  const tts = state.providers.find((p) => p.kind === 'tts' && p.type === 'deepgram')!;
  state.services = {
    stt: { providerId: stt.id, model: 'flux-general-multi' },
    llm: { providerId: llm.id, model: 'gpt-4o-mini' },
    tts: { providerId: tts.id, model: 'flux-haley-en' },
  };
  return state;
}

function run() {
  const state = configuredState();
  const medicare = state.agents.find((a) => a.id === 'a_medicare')!;
  const jessica = shipped.agents.find((a: any) => a.id === 'a_jessica');
  const campaign = state.campaigns.find((c) => c.id === 'c_medicare')!;
  const fronter = shipped.campaigns.find((c: any) => c.id === 'c_med_fronter');

  // The TypeScript wrapper and browser UMD must expose the same implementation.
  for (const key of Object.keys(shared)) assert.equal(typeof (shared as any)[key], typeof (require('../src/persona') as any)[key], `persona export parity: ${key}`);
  assert.equal(composeBehavioralPrompt, shared.composeBehavioralPrompt);
  assert.equal(createConversationMemory, shared.createConversationMemory);

  // Server settings and the shared composer must not drift.
  const wire = buildDeepgramSettings(state, medicare, campaign);
  assert.equal(wire.agent.think.prompt, composeBehavioralPrompt(medicare, campaign));
  const integrity = conversationIntegrityLines();
  assert(wire.agent.think.prompt.endsWith(integrity[integrity.length - 1]), 'Integrity rules must be appended last');
  assert(wire.agent.think.prompt.length <= MAX_PROMPT_LENGTH);

  // Disabled persona options need explicit negative instructions, not silence.
  const restricted = { ...medicare, behavior: { ...medicare.behavior, allowGeneralQa: false, vocalGestures: false } };
  const restrictedPrompt = composeBehavioralPrompt(restricted, campaign);
  assert(restrictedPrompt.includes('GENERAL Q&A DISABLED'));
  assert(restrictedPrompt.includes('VOCAL GESTURES DISABLED'));
  assert(!restrictedPrompt.includes('GENERAL KNOWLEDGE & OPEN Q&A'));
  assert(!restrictedPrompt.includes('NATURAL VOCAL GESTURES:'));

  // Campaign rules are clamped without dropping the final integrity rules.
  const longCampaign = { ...campaign, complianceRules: 'R'.repeat(MAX_CAMPAIGN_RULES + 500) + 'TAIL_MARKER' };
  const longPrompt = composeBehavioralPrompt({ ...medicare, prompt: 'P'.repeat(MAX_PROMPT_LENGTH) }, longCampaign);
  assert(longPrompt.length <= MAX_PROMPT_LENGTH);
  assert(!longPrompt.includes('TAIL_MARKER'));
  assert(longPrompt.endsWith(integrity[integrity.length - 1]));

  // Identity defaults and legacy self-intro migration.
  assert(defaultSelfIntro('a_jessica', 'Jessica - Medicare').includes("I'm Jessica"));
  assert(migrateLegacySelfIntro(legacyHaleyIntro, 'a_jessica', 'Jessica - Medicare').includes("I'm Jessica"));
  assert.equal(migrateLegacySelfIntro('My custom introduction.', 'a_jessica', 'Jessica - Medicare'), 'My custom introduction.');

  // Exact stock prompt/rule migration; customized operator text is preserved.
  assert.equal(fingerprint(legacyMedicarePrompt), '4096:1042707137:116207873');
  assert.equal(fingerprint(legacyJessicaPrompt), '629:3652710674:4038630760');
  assert.equal(migrateLegacyQualificationPrompt(legacyMedicarePrompt, medicare.prompt), medicare.prompt);
  assert.equal(migrateLegacyQualificationPrompt(legacyJessicaPrompt, jessica.prompt), jessica.prompt);
  assert.equal(migrateLegacyQualificationPrompt('Custom Medicare script.', medicare.prompt), 'Custom Medicare script.');
  assert.equal(migrateLegacyCampaignRules(legacyMedicareRules, campaign.complianceRules, 'c_medicare'), campaign.complianceRules);
  assert.equal(migrateLegacyCampaignRules(legacyFronterRules, fronter.complianceRules, 'c_med_fronter'), fronter.complianceRules);
  assert.equal(migrateLegacyCampaignRules('Custom campaign rules.', campaign.complianceRules, 'c_medicare'), 'Custom campaign rules.');

  const legacyState = configuredState();
  legacyState.agents.find((a) => a.id === 'a_medicare')!.prompt = legacyMedicarePrompt;
  legacyState.campaigns.find((c) => c.id === 'c_medicare')!.complianceRules = legacyMedicareRules;
  const normalized = normalizeState(legacyState);
  assert.equal(normalized.agents.find((a) => a.id === 'a_medicare')!.prompt, medicare.prompt);
  assert.equal(normalized.campaigns.find((c) => c.id === 'c_medicare')!.complianceRules, campaign.complianceRules);

  // Caller-fact memory: only explicit caller statements become transfer metadata.
  const memory = createConversationMemory();
  memory.addUserText('Do I have Medicare Part A?');
  memory.addUserText("I'm not sure if I have Medicare.");
  memory.addUserText('My wife has Medicare Part B.');
  assert.deepEqual(memory.facts(), { statedAge: null, medicareStatus: null, userTurns: 3 });
  assert(memory.qualificationBlockers(campaign).length > 0, 'Unconfirmed Medicare must block the stock Medicare transfer');
  assert.deepEqual(memory.qualificationBlockers({ complianceRules: 'Custom campaign rules.' }), [], 'Custom campaigns are not guessed from a name');

  memory.addUserText('Yes, I have Medicare Part A and Part B.');
  assert.equal(memory.facts().medicareStatus, 'Part A & B');
  assert.equal(memory.facts().statedAge, null);
  assert.deepEqual(memory.qualificationBlockers(campaign), []);
  let sanitized = memory.sanitizeTransferArgs({ reason: 'review', confirmed_age: '71', medicare_status: 'Part A & B' });
  assert.equal(sanitized.args.confirmed_age, undefined);
  assert.deepEqual(sanitized.omitted, ['confirmed_age']);
  assert.equal(sanitized.args.medicare_status, 'Part A & B');

  memory.addUserText('Actually I am 61 years old.');
  assert.equal(memory.facts().statedAge, '61');
  assert(memory.qualificationBlockers(campaign).some((b) => b.includes('65-85')));
  sanitized = memory.sanitizeTransferArgs({ confirmed_age: '71', medicare_status: 'Part A' });
  assert.equal(sanitized.args.confirmed_age, undefined);
  assert.equal(sanitized.args.medicare_status, 'Part A & B', 'Model metadata is corrected to the caller-confirmed parts');
  assert.deepEqual(sanitized.corrected, ['medicare_status']);
  const generic = createConversationMemory();
  generic.addUserText('Yes, I have Medicare.');
  sanitized = generic.sanitizeTransferArgs({ medicare_status: 'Part A' });
  assert.equal(sanitized.args.medicare_status, undefined, 'A specific part must not be invented from generic Medicare confirmation');
  assert.deepEqual(sanitized.omitted, ['medicare_status']);

  const spoken = createConversationMemory();
  spoken.addUserText("I'm seventy-one and I have Medicare Part A, but not Part B.");
  assert.equal(spoken.facts().statedAge, '71');
  assert.equal(spoken.facts().medicareStatus, 'Part A');
  sanitized = spoken.sanitizeTransferArgs({ confirmed_age: '71', medicare_status: 'Medicare' });
  assert.equal(sanitized.args.medicare_status, 'Part A');
  assert.deepEqual(sanitized.corrected, ['medicare_status']);

  const contextual = createConversationMemory();
  contextual.addAssistantText('Are you currently on Medicare Part A or Part B?');
  contextual.addUserText('Yes.');
  assert.equal(contextual.facts().medicareStatus, 'Medicare', 'A bare yes answers the pending Medicare question');
  assert.deepEqual(contextual.qualificationBlockers(campaign), []);
  contextual.addAssistantText('Are you currently on Medicare Part A or Part B?');
  contextual.addUserText('No.');
  assert.equal(contextual.facts().medicareStatus, null);

  const scenario = createConversationMemory();
  scenario.addUserText('Lead says "Yes, I have Medicare Part A and Part B"');
  assert.equal(scenario.facts().medicareStatus, 'Part A & B');

  // The hand-maintained static defaults must stay aligned with the server defaults.
  const shippedMedicare = shipped.agents.find((a: any) => a.id === 'a_medicare');
  const shippedJessica = shipped.agents.find((a: any) => a.id === 'a_jessica');
  assert.equal(shippedMedicare.prompt, medicare.prompt);
  assert.equal(shippedJessica.behavior.selfIntro, defaultSelfIntro('a_jessica', 'Jessica - Medicare'));
  assert.deepEqual(shipped.tests.a_medicare, state.tests.a_medicare);
  assert.equal(shipped.campaigns.find((c: any) => c.id === 'c_medicare').complianceRules, campaign.complianceRules);
  assert.equal(shipped.campaigns.find((c: any) => c.id === 'c_med_fronter').complianceRules, fronter.complianceRules);
  const shippedXfer = shipped.functions.find((f: any) => f.id === 'fn_xfer');
  const serverXfer = state.functions.find((f) => f.id === 'fn_xfer')!;
  assert.equal(shippedXfer.description, serverXfer.description);
  assert.deepEqual(JSON.parse(shippedXfer.params), JSON.parse(serverXfer.params));

  console.log('✓ Persona composer parity, integrity-last clamp, explicit negatives, exact legacy migrations, caller-fact transfer guards and default-state parity');
}

run();
