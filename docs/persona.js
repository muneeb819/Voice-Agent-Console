/* Shared persona/behavior prompt composition.
 *
 * The server bridge and the static browser used to carry two separate copies of
 * this logic, so a persona setting could be honored on one path and silently
 * dropped on the other. One implementation is now shared by both, exactly like
 * opening.js, and the release bundle ships it.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VacPersona = api;
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';

  const MAX_PROMPT_LENGTH = 24950;
  const MAX_CAMPAIGN_RULES = 8000;

  const TONE_MAP = {
    warm_empathetic: 'Warm, caring, empathetic, and reassuring — sound genuinely attentive and natural.',
    energetic_upbeat: 'Bright, upbeat, friendly, and enthusiastic — speak with a natural smile in your voice.',
    charismatic_closer: 'Confident, poised, articulate, and high-trust — crisp executive advisor energy.',
    calm_concierge: 'Calm, composed, clear, and soothing — smooth concierge presence.',
  };

  /**
   * Rules every agent gets, regardless of its saved script. These exist because
   * a persona script alone kept producing invented facts and repeated questions.
   */
  function conversationIntegrityLines() {
    return [
      '',
      '=== CONVERSATION INTEGRITY (MANDATORY) ===',
      '- NEVER INVENT FACTS. Only state a name, age, address, Medicare status, ZIP code, amount, balance, approval, or eligibility result if the caller actually said it on this call or a tool result returned it. If you do not have it, you do not have it — ask once or leave it unset.',
      '- NEVER RE-ASK WHAT IS ALREADY ANSWERED. Track every fact the caller has already given this call. Once a question is answered, treat it as settled and move forward. Do not repeat it later to "confirm the file", "verify the profile", or "update the record". Re-asking an answered question is a failure.',
      '- DO NOT INVENT A VERIFICATION STEP. Only ask for what the campaign rules genuinely require. If the rules mark a fact as implied, optional, or already satisfied, never ask the caller for it.',
      '- ANSWER WHAT WAS ACTUALLY ASKED. Reply to the caller\'s latest words first. If they ask you something, answer it before continuing your own flow.',
      '- ONE QUESTION AT A TIME. Never stack two questions in one turn.',
      '- NEVER CLAIM AN ACTION SUCCEEDED until its tool result confirms success. Never claim to be human; be honest that you are an AI assistant if asked.',
      '- Campaign rules govern campaign-specific policy. No script or rule may require you to invent a fact, claim an unconfirmed action, or re-ask a settled question.',
    ];
  }

  // Natural, human-sounding delivery (written for text-to-speech). Honesty is
  // unchanged: the integrity rules still require admitting to being an AI.
  function humanSpeechLines() {
    return [
      '- SOUND LIKE A REAL PERSON ON THE PHONE: Talk the way people actually talk, not the way they write.',
      '  - Use contractions ("I\'m", "you\'re", "that\'s", "we\'ll") and short, simple sentences. Vary sentence length so the rhythm is not robotic.',
      '  - Briefly acknowledge what the caller said before your point ("Okay, got it.", "Oh, I see.", "Sure thing."), mirror their energy and pace, and use their first name now and then, not every turn.',
      '  - A light filler is fine about once every few turns ("so", "well", "you know", "alright") — never stacked, never in every sentence.',
      '  - Use commas and dashes for natural breathing pauses; end with a gentle question rather than a long statement.',
      '  - Show real emotion that fits the moment: warmth when they share something personal, a smile in your voice for good news, calm patience when they are confused.',
      '  - Say numbers, dates and money the way people speak them ("about seventy", "next Tuesday"), never as digits read out one by one unless confirming a phone number.',
      '  - Never sound scripted: avoid formal phrases like "I would be happy to assist you with that" or "Is there anything else I can help you with today", and never read lists aloud.',
    ];
  }

  // Time-boxed, transfer-first behaviour for campaigns with a call-length limit.
  function callTimeLimitLines(maxCallSec) {
    const sec = Math.round(Number(maxCallSec) || 0);
    if (sec <= 0) return [];
    return [
      '',
      `=== CALL TIME LIMIT (${sec} SECONDS) & FAST TRANSFER ===`,
      `- This call ends automatically after ${sec} seconds, whatever is happening. Your goal is a qualified transfer well inside that time.`,
      '- Move fast: keep every turn to one short sentence plus at most one question. No small talk, no recaps, no repeating what the caller already said.',
      '- Ask only the qualifying questions the campaign rules actually require, in the fewest turns. The moment the caller qualifies and agrees, set XFER and call transfer_to_live_agent immediately.',
      '- If the caller hesitates, give one short benefit-focused reason to speak with the specialist (only where the campaign rules allow it), then ask once more. Never rebut a stop, do-not-call or hang-up request.',
      '- If the caller is joking, testing you, stalling or going off topic, steer back once; if it continues, close politely, set the matching disposition and call end_call.',
      '- If you receive a TIME CHECK message, follow it immediately.',
    ];
  }

  // Universal hang-up policy. The telephone line never ends by itself: if the
  // model says goodbye without calling end_call, the caller is left on an open
  // line. Applies to every bot that has the end_call tool, whatever its own
  // prompt covers.
  function callEndingLines() {
    return [
      '',
      '=== CALL ENDING (MANDATORY WHEN THE end_call TOOL IS AVAILABLE) ===',
      '- The line never hangs up by itself. Saying goodbye is not enough: you must call the end_call tool, or the caller is left on an open line.',
      '- Say one short, polite closing sentence, then call end_call in the same turn when ANY of these happens:',
      '  1. The caller says goodbye, bye, "I have to go", or asks you to hang up or end the call.',
      '  2. The caller is not interested, says stop, or asks not to be called again.',
      '  3. Wrong person or wrong number, or the person you need is not available.',
      '  4. You reach a voicemail greeting, answering machine, or automated system.',
      '  5. The caller is disqualified under the campaign rules.',
      '  6. The conversation is complete and the caller needs nothing else.',
      '- If set_disposition is available, record the matching allowed disposition first (for example NI for not interested, DNC for do-not-call, NA for voicemail or no answer), then call end_call.',
      '- Never call end_call after transfer_to_live_agent succeeded; the transfer releases you automatically.',
      '- Silence alone never ends the call.',
    ];
  }

  // Background voices: Deepgram transcribes everyone near the phone, so the
  // model must not treat a side remark from someone else as the customer's answer.
  function backgroundVoiceLines() {
    return [
      '',
      '=== BACKGROUND VOICES (ALWAYS) ===',
      '- You are speaking with ONE customer on the phone. Other people, a TV or a radio may be heard near them, and their words can appear in what you hear.',
      '- Only respond to words that are clearly part of the customer\'s conversation with you. Ignore side remarks aimed at someone else (for example "turn that down", "who is it?", "I\'m on the phone", "dinner is ready", names called out) and TV or radio lines.',
      '- If a fragment does not fit what you just asked, do not treat it as an answer and do not change topic; continue from where you were or briefly re-ask your last question.',
      '- If two answers conflict or the line sounds busy, ask once: "Sorry, it sounds a little busy there, was that a yes?" Never ask more than once per question.',
      '- Never record a qualification answer, disposition or transfer from words that may have come from someone else.',
    ];
  }

  function composeBehavioralPrompt(agent, campaign) {
    const basePrompt = String((agent && agent.prompt) || '').trim();
    const b = agent && agent.behavior;
    const lines = [];

    if (b) {
      lines.push('', '=== REAL-TIME VOICE ASSISTANT, BARGE-IN, EXPRESSIONS & GENERAL Q&A ===');
      const selfIntro = String(b.selfIntro || '').trim();
      if (selfIntro) {
        lines.push(
          `- SELF-INTRODUCTION: Whenever greeted casually or asked "Who are you?", "What is your name?", "Introduce yourself", or "What can you do?", warmly introduce yourself in 1–2 natural spoken sentences based on: "${selfIntro}"`
        );
      }
      if (b.allowGeneralQa === false) {
        lines.push(
          '- GENERAL Q&A DISABLED: Do not answer unrelated general-knowledge, trivia, math, science, or advice questions. Briefly say that is outside this call\'s scope, then offer only the assigned campaign help. Always honor DNC, language-barrier, and safety requests first.'
        );
      } else {
        lines.push(
          '- GENERAL KNOWLEDGE & OPEN Q&A: If the caller asks ANY general question (science, math, geography, technology, definitions, advice, trivia, or everyday small talk), answer it directly, accurately, and warmly in 1–2 concise spoken sentences instead of deflecting. Always honor the assigned campaign rules, DNC, language barriers, and eligibility gates first.'
        );
      }
      if (b.bargeIn !== 'off') {
        lines.push(
          '- LIVE BARGE-IN AWARENESS: The caller can interrupt you mid-sentence at any time. If interrupted, never repeat cut-off sentences — pivot immediately and naturally to their latest question or remark.'
        );
      }
      lines.push(`- VOCAL EXPRESSION STYLE: ${TONE_MAP[b.expressionStyle] || TONE_MAP.warm_empathetic}`);
      if (b.vocalGestures === false) {
        lines.push(
          '- VOCAL GESTURES DISABLED: Do not add filler reactions or micro-gestures such as "Oh, great question!", "Gotcha —", "Mm-hmm", or "Haha". Answer plainly and naturally. Never output bracketed or asterisk stage directions.'
        );
      } else {
        lines.push(
          '- NATURAL VOCAL GESTURES: Use subtle, authentic spoken micro-gestures when natural ("Oh, great question!", "Gotcha —", "Mm-hmm, I hear you.", "Right, so—") and natural conversational pauses ("—"). NEVER output bracketed or asterisk tags like [laughs], [smiles], (sighs), or *waves* because TTS speaks brackets literally.',
          ...humanSpeechLines()
        );
      }
      if (b.latencyProfile === 'ultra') {
        lines.push(
          '- ULTRA-LOW LATENCY STREAMING: Begin every reply immediately with the core answer or reaction in the first 4–6 words. Keep turns crisp (1–2 spoken sentences, ~15–35 words unless asked for detail) in plain spoken words with zero markdown (*, #, bullets).'
        );
      } else if (b.latencyProfile === 'balanced') {
        lines.push(
          '- BALANCED CONVERSATIONAL STREAMING: Keep turns natural (2–3 spoken sentences, ~25–50 words unless asked for detail) in plain spoken words with zero markdown (*, #, bullets).'
        );
      } else if (b.latencyProfile === 'quality') {
        lines.push(
          '- DETAILED RESPONSE STREAMING: Give complete, thorough answers (3–5 spoken sentences unless asked for brevity) in plain spoken words with zero markdown (*, #, bullets).'
        );
      }
    }

    if (campaign) {
      const rules = String(campaign.complianceRules || '').trim().slice(0, MAX_CAMPAIGN_RULES);
      lines.push(
        '',
        '=== MANDATORY CAMPAIGN-SPECIFIC COMPLIANCE & RULES ===',
        `- The only campaign assigned to this call is ${JSON.stringify(campaign.name)} (VICIdial campaign ${JSON.stringify(campaign.viciCampaign)}). Do not use another campaign's rules.`,
        '- The rules below are mandatory and override any conflicting persona, sales script, saved agent prompt, or general-answer instruction. Follow them throughout the call.',
        `- Campaign rules:\n${rules || '[NO CAMPAIGN RULES CONFIGURED — do not start a live call.]'}`,
        '- After the one-second listen, a silent caller receives the configured opening once. Silence alone never ends the call or applies a disposition; continue listening for the caller.'
      );
      // Only the campaign's phone bot is time-boxed; pool bots such as the QA
      // supervisor are reviewers, not callers.
      if (!campaign.agentId || !agent || campaign.agentId === agent.id) {
        lines.push(...callTimeLimitLines(campaign.maxCallSec));
      }
      const disclosure = String(campaign.disclosure || '').trim();
      if (disclosure) {
        lines.push(
          `- Campaign disclosure text is ${JSON.stringify(disclosure)}. It is prepended to the opening only when this agent's campaign-disclosure setting is enabled; never claim a recording or practice that is not actually in effect.`
        );
      }
    }

    lines.push(...backgroundVoiceLines());
    lines.push(...callEndingLines());
    lines.push(...conversationIntegrityLines());
    const suffix = lines.join('\n').trim();
    if (!suffix) return basePrompt;
    const truncationNote = '\n[Agent prompt shortened to preserve the mandatory campaign rules below.]';
    const availableBaseLength = Math.max(0, MAX_PROMPT_LENGTH - suffix.length - 1 - truncationNote.length);
    const safeBase = basePrompt.slice(0, availableBaseLength);
    const note = basePrompt.length > safeBase.length ? truncationNote : '';
    return `${safeBase}${note}\n${suffix}`.trim();
  }

  function defaultSelfIntro(id, name) {
    if (id === 'a_jessica' || /jessica/i.test(name || '')) {
      return "Hi! I'm Jessica, an AI Medicare benefits assistant. I can help check whether a specialist review may be useful, and I'm happy to answer questions.";
    }
    if (id === 'a_nova' || /nova|concierge|general/i.test(name || '')) {
      return "Hi there! I'm Nova, an AI customer support and concierge assistant. I'm happy to chat naturally and help answer general knowledge, everyday, or support questions.";
    }
    if (id === 'a1' || /final expense|sarah/i.test(name || '')) {
      return "Hi! I'm Sarah, an AI coverage assistant. I help folks explore final expense options and connect with licensed specialists, and I'm happy to answer questions too.";
    }
    if (id === 'a_medicare' || /medicare/i.test(name || '')) {
      return "Hi! I'm Haley, an AI benefits assistant calling from the Benefits Department. I can help check whether a specialist review may be useful, and I'm happy to answer questions along the way.";
    }
    return `Hi! I'm ${name || 'Alex'}, an AI assistant, happy to chat naturally and help with any questions you have.`;
  }

  const LEGACY_SELF_INTROS = new Set([
    "Hi there! I'm Nova, a live Customer Support & Concierge Specialist here on the line. I'm happy to chat naturally and help answer any general knowledge, everyday, or support question you have!",
    "Hi! I'm Haley, a live Benefits Advisor calling from the Benefits Department. I help Medicare beneficiaries check their Food and OTC allowance eligibility, and I'm happy to answer any questions you have along the way!",
    "Hi! I'm Sarah, a live Senior Coverage Coordinator. I help folks explore final expense options and connect with our licensed specialists, and I'm always happy to answer your questions too!",
  ]);

  function migrateLegacySelfIntro(value, id, name) {
    const text = String(value || '').trim();
    if (!text) return defaultSelfIntro(id, name);
    if (LEGACY_SELF_INTROS.has(text)) return defaultSelfIntro(id, name);
    if (/^Hi! I'm .+, a live specialist here on the line, happy to chat naturally and help with any questions you have!$/.test(text)) {
      return defaultSelfIntro(id, name);
    }
    return text;
  }

  const MEDICARE_RULE_MARKER = 'caller-confirmed Medicare Part A or Part B satisfies the qualification step';

  /** Only the reviewed stock Medicare policy gets this backend guard. Custom
   *  campaign rules are not guessed from a campaign name. */
  function campaignRequiresMedicareConfirmation(campaign) {
    return String((campaign && campaign.complianceRules) || '').includes(MEDICARE_RULE_MARKER);
  }

  // Med Benefits Medicare verification template (Jessica): the campaign rules
  // themselves carry this heading, so the backend enforces the same matrix.
  const MED_BENEFITS_RULE_MARKER = 'MED BENEFITS MEDICARE — MANDATORY CAMPAIGN RULES';
  function campaignUsesMedBenefitsScreening(campaign) {
    return String((campaign && campaign.complianceRules) || '').includes(MED_BENEFITS_RULE_MARKER);
  }

  const SMALL_NUMBERS = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
    ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
    seventeen: 17, eighteen: 18, nineteen: 19,
  };
  const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
  const NUMBER_WORD = '(?:' + Object.keys(SMALL_NUMBERS).concat(Object.keys(TENS)).join('|') + ')';
  const SPOKEN_AGE = '(?:one\\s+hundred(?:\\s+(?:and\\s+)?(?:' + NUMBER_WORD + '(?:[\\s-]' + NUMBER_WORD + ')?))?|' +
    '(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[\\s-](?:one|two|three|four|five|six|seven|eight|nine))?|' +
    Object.keys(SMALL_NUMBERS).join('|') + ')';

  function parseSpokenNumber(value) {
    const words = String(value).toLowerCase().replace(/-/g, ' ').split(/\s+/).filter((w) => w && w !== 'and');
    if (!words.length) return null;
    let total = 0;
    let current = 0;
    for (const word of words) {
      if (word === 'hundred') {
        if (current === 0 || current > 1) return null;
        current *= 100;
      } else if (Object.prototype.hasOwnProperty.call(SMALL_NUMBERS, word)) {
        current += SMALL_NUMBERS[word];
      } else if (Object.prototype.hasOwnProperty.call(TENS, word)) {
        current += TENS[word];
      } else {
        return null;
      }
    }
    total += current;
    return total >= 0 && total <= 120 ? total : null;
  }

  function isUncertainOrReported(clause) {
    return /\b(?:maybe|not sure|unsure|i think|think so|probably|might|may have|possibly|wondering|whether|if|said|told|asked)\b/.test(clause) ||
      /^\s*(?:do|does|did|is|are|am|can|could|would|will|what|which|why|how|who|when)\b/.test(clause) ||
      /\b(?:my|our|the)\s+(?:wife|husband|mother|father|parent|friend|neighbor|client|customer)\b|\b(?:he|she|they|someone|somebody)\s+(?:has|have|is|are|had)\b/.test(clause);
  }

  function extractStatedAge(sentence) {
    if (isUncertainOrReported(sentence)) return null;
    const clauses = sentence.split(/[,;]|\bbut\b|\bhowever\b|\balhough\b/);
    for (const clause of clauses) {
      if (/\b(?:not|never|isn't|is not|am not|i'm not|im not)\b/.test(clause)) continue;
      const patterns = [
        /\b(?:my\s+)?(?:current\s+)?age\s+is\s+(\d{1,3})\b/,
        /\b(?:i\s*am|i['’]m|im)\s+(?:currently\s+)?(\d{1,3})\b/,
        /\b(\d{1,3})\s+years?\s+old\b/,
        /\b(?:i\s+am\s+)?aged\s+(\d{1,3})\b/,
        new RegExp('\\b(?:my\\s+)?(?:current\\s+)?age\\s+is\\s+(' + SPOKEN_AGE + ')\\b'),
        new RegExp('\\b(?:i\\s*am|i[\'’]m|im)\\s+(?:currently\\s+)?(' + SPOKEN_AGE + ')\\b'),
        new RegExp('\\b(' + SPOKEN_AGE + ')\\s+years?\\s+old\\b'),
      ];
      for (const pattern of patterns) {
        const match = clause.match(pattern);
        if (!match) continue;
        const age = /^\d+$/.test(match[1]) ? Number(match[1]) : parseSpokenNumber(match[1]);
        if (age !== null && age >= 0 && age <= 120) return String(age);
      }
    }
    return null;
  }

  function partIsNegated(clause, part) {
    const index = clause.search(new RegExp('\\bpart\\s*' + part + '\\b'));
    if (index < 0) return false;
    return /\b(?:no|not|never|without|don't|do not|doesn't|does not|didn't|did not|lack|lost|cancelled|canceled|disenrolled|no longer)\b[^]{0,40}$/.test(clause.slice(0, index));
  }

  /** Collect only facts the caller actually stated. Never infer age from Medicare. */
  function createConversationMemory() {
    const userTexts = [];
    let statedAge = null;
    let hasPartA = false;
    let hasPartB = false;
    let hasGenericMedicare = false;
    let pendingMedicareQuestion = false;
    let pendingBothPartsQuestion = false;
    let pendingAgeQuestion = false;
    let pendingDisabilityQuestion = false;
    let hasDisability = null;

    function currentMedicareStatus() {
      if (hasPartA && hasPartB) return 'Part A & B';
      if (hasPartA) return 'Part A';
      if (hasPartB) return 'Part B';
      if (hasGenericMedicare) return 'Medicare';
      return null;
    }

    function addAssistantText(value) {
      const text = String(value || '').toLowerCase();
      pendingMedicareQuestion = /\bmedicare\b/.test(text) && /\?|\b(?:do you have|are you on|are you enrolled|have you got)\b/.test(text);
      // "Are you enrolled in both Medicare Part A and Part B?" -> a bare "yes" confirms both.
      pendingBothPartsQuestion = pendingMedicareQuestion && /\bpart\s*a\b/.test(text) && /\bpart\s*b\b/.test(text) &&
        /\bboth\b|\bpart\s*a\s*(?:and|&)\s*(?:medicare\s+)?part\s*b\b/.test(text) && !/\bpart\s*a\s*or\b/.test(text);
      pendingAgeQuestion = /\?/.test(text) && /\b(?:how old|your (?:current )?age|what age|age are you)\b/.test(text);
      pendingDisabilityQuestion = /\?/.test(text) && /\bdisabilit(?:y|ies)\b|\bdisabled\b/.test(text);
    }

    function addUserText(value) {
      let text = String(value || '').trim();
      if (!text) return;
      // Scenario buttons inject a quoted caller utterance; parse the quote, not
      // the operator's "Lead says" wrapper.
      const scenario = text.match(/^(?:lead|caller|user|customer)\s+(?:says|said|responds|replies)\s*[:\-]?\s*["“](.+)["”]\s*$/i);
      if (scenario) text = scenario[1].trim();
      userTexts.push(text);
      if (userTexts.length > 40) userTexts.shift();

      const bareAffirmative = /^(?:yes|yeah|yep|yes i do|i do|correct|that's right|that is right)[.!]?$/i.test(text);
      const bareNegative = /^(?:no|nope|not really|i don't|i do not)[.!]?$/i.test(text);
      if (pendingMedicareQuestion && bareAffirmative) hasGenericMedicare = true;
      if (pendingBothPartsQuestion && bareAffirmative) { hasPartA = true; hasPartB = true; }
      if (pendingMedicareQuestion && bareNegative) { hasPartA = false; hasPartB = false; hasGenericMedicare = false; }
      if (pendingDisabilityQuestion && bareAffirmative) hasDisability = true;
      if (pendingDisabilityQuestion && bareNegative) hasDisability = false;
      if (pendingAgeQuestion) {
        // A bare answer to "How old are you?": "72", "72.", "seventy-two", "I'm 72" (handled below).
        const bare = text.toLowerCase().replace(/[.!]+$/, '').trim();
        const n = /^\d{1,3}$/.test(bare) ? Number(bare) : new RegExp('^' + SPOKEN_AGE + '$').test(bare) ? parseSpokenNumber(bare) : null;
        if (n !== null && n >= 0 && n <= 120) statedAge = String(n);
      }
      pendingMedicareQuestion = false;
      pendingBothPartsQuestion = false;
      pendingAgeQuestion = false;
      pendingDisabilityQuestion = false;

      const sentences = text.toLowerCase().match(/[^.!?\n]+[.!?]?/g) || [];
      for (const sentence of sentences) {
        if (sentence.includes('?')) continue;
        const age = extractStatedAge(sentence);
        if (age !== null) statedAge = age;
        if (isUncertainOrReported(sentence)) continue;
        if (/\b(?:i\s+(?:have|do have)\s+a\s+disability|i\s*(?:am|['’]m)\s+(?:disabled|on disability)|i\s+(?:get|receive)\s+(?:disability|ssdi))\b/.test(sentence)) {
          hasDisability = !/\b(?:no|not|never|don't|do not|doesn't|does not)\b[^]{0,25}\bdisab/.test(sentence);
        } else if (/\b(?:i\s+(?:don't|do not)\s+have\s+a\s+disability|i\s*(?:am|['’]m)\s+not\s+disabled|no disability)\b/.test(sentence)) {
          hasDisability = false;
        }

        const mentionsMedicare = /\bmedicare\b/.test(sentence);
        const medicareNegated = /\b(?:no|not|never|without|don't|do not|doesn't|does not|didn't|did not|lost|cancelled|canceled|disenrolled|no longer)\b[^]{0,50}\bmedicare\b/.test(sentence);
        if (mentionsMedicare && medicareNegated) {
          hasPartA = false;
          hasPartB = false;
          hasGenericMedicare = false;
        } else if (mentionsMedicare && /\b(?:yes|yeah|yep|i\s+(?:have|do have|am on|am enrolled in|enrolled in|receive|get)|i['’]m on|im on|active)\b/.test(sentence)) {
          hasGenericMedicare = true;
          if (/\bboth\b/.test(sentence)) { hasPartA = true; hasPartB = true; }
        }

        for (const clause of sentence.split(/[,;]|\bbut\b|\bhowever\b|\balhough\b/)) {
          if (isUncertainOrReported(clause)) continue;
          const affirmative = /\b(?:yes|yeah|yep|i\s+(?:have|do have|am on|am enrolled in|enrolled in|receive|get)|i['’]m on|im on|active)\b/.test(clause) ||
            /^\s*part\s*[ab]\b/.test(clause);
          const hasA = /\bpart\s*a\b/.test(clause);
          const hasB = /\bpart\s*b\b/.test(clause) || /\bpart\s*a\s*(?:&|and)\s*b\b/.test(clause);
          if (hasA) {
            if (partIsNegated(clause, 'a')) hasPartA = false;
            else if (affirmative) hasPartA = true;
          }
          if (hasB) {
            if (partIsNegated(clause, 'b')) hasPartB = false;
            else if (affirmative) hasPartB = true;
          }
        }
      }
    }

    function facts() {
      return { statedAge, medicareStatus: currentMedicareStatus(), userTurns: userTexts.length, ...(hasDisability === null ? {} : { disability: hasDisability }) };
    }

    function normalizeMedicareStatus(value) {
      const text = String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
      if (/^(?:medicare\s+)?part\s*a\s*(?:&|and)\s*(?:part\s*)?b$/.test(text) || /^(?:part\s*)?a\s*(?:&|and)\s*(?:part\s*)?b$/.test(text) || text === 'both') return 'Part A & B';
      if (/^(?:medicare\s+)?part\s*a$/.test(text) || text === 'a') return 'Part A';
      if (/^(?:medicare\s+)?part\s*b$/.test(text) || text === 'b') return 'Part B';
      if (/^(?:active\s+)?medicare$/.test(text) || text === 'yes') return 'Medicare';
      return null;
    }

    /** Strip or downgrade model-invented metadata before it reaches a lead record. */
    function sanitizeTransferArgs(args) {
      const clean = args && typeof args === 'object' && !Array.isArray(args) ? { ...args } : {};
      const omitted = [];
      const corrected = [];
      if (clean.confirmed_age !== undefined && clean.confirmed_age !== null && String(clean.confirmed_age).trim() !== '') {
        const requestedAge = String(clean.confirmed_age).trim();
        if (statedAge === null || requestedAge !== statedAge) {
          delete clean.confirmed_age;
          omitted.push('confirmed_age');
        } else {
          clean.confirmed_age = statedAge;
        }
      } else {
        delete clean.confirmed_age;
      }

      const evidence = currentMedicareStatus();
      if (clean.medicare_status !== undefined && clean.medicare_status !== null && String(clean.medicare_status).trim() !== '') {
        const requested = normalizeMedicareStatus(clean.medicare_status);
        if (evidence === null || requested === null || (evidence === 'Medicare' && requested !== 'Medicare')) {
          delete clean.medicare_status;
          omitted.push('medicare_status');
        } else if (requested !== evidence) {
          clean.medicare_status = evidence;
          corrected.push('medicare_status');
        } else {
          clean.medicare_status = evidence;
        }
      } else {
        delete clean.medicare_status;
      }
      return { args: clean, omitted, corrected };
    }

    /** Backend guard for the reviewed stock Medicare policy only. */
    function qualificationBlockers(campaign) {
      if (campaignUsesMedBenefitsScreening(campaign)) {
        // Same matrix as the campaign rules; enforced here so a prompt slip cannot transfer.
        const blockers = [];
        const age = statedAge === null ? null : Number(statedAge);
        if (age === null) blockers.push('Caller has not stated their age on this call.');
        else if (age < 30 || age > 100) blockers.push(`Caller stated age ${age}, outside this campaign's 30-100 screening range.`);
        else if (age < 65 && hasDisability !== true) blockers.push(`Caller aged ${age} has not confirmed a disability (required for ages 30-64).`);
        if (currentMedicareStatus() !== 'Part A & B') blockers.push('Caller has not confirmed BOTH Medicare Part A and Part B on this call.');
        return blockers;
      }
      if (!campaignRequiresMedicareConfirmation(campaign)) return [];
      const blockers = [];
      if (currentMedicareStatus() === null) {
        blockers.push('Caller Medicare Part A/B has not been confirmed on this call.');
      }
      if (statedAge !== null && (Number(statedAge) < 65 || Number(statedAge) > 85)) {
        blockers.push(`Caller stated age ${statedAge}, outside this campaign's 65-85 band.`);
      }
      return blockers;
    }

    return { addUserText, addAssistantText, facts, sanitizeTransferArgs, qualificationBlockers };
  }

  function fingerprint(text) {
    let fnv = 2166136261;
    let djb = 5381;
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      fnv = Math.imul(fnv ^ code, 16777619) >>> 0;
      djb = (Math.imul(djb, 33) + code) >>> 0;
    }
    return `${text.length}:${fnv}:${djb}`;
  }

  // Fingerprints of the shipped Medicare scripts that made the bot ask for age
  // after Medicare was already confirmed. Only an exact stock match is
  // upgraded; an operator-edited prompt is never overwritten.
  const LEGACY_AGE_ASKING_STOCK = new Set([
    '4096:1042707137:116207873',
    '4078:920261032:1228609812',
    '629:3652710674:4038630760',
  ]);

  /**
   * Upgrade the retired stock Medicare script to the corrected one.
   * `currentStock` is the prompt shipped with this build.
   */
  function migrateLegacyQualificationPrompt(value, currentStock) {
    const text = String(value || '');
    const stock = String(currentStock || '');
    if (!stock || text === stock) return text;
    return LEGACY_AGE_ASKING_STOCK.has(fingerprint(text)) ? stock : text;
  }

  const LEGACY_CAMPAIGN_RULES = new Map([
    ['207:1685392075:883222663', 'c_medicare'],
    ['201:2432257898:746566736', 'c_med_fronter'],
  ]);

  /** Upgrade only the exact retired stock campaign rules for the same stock id. */
  function migrateLegacyCampaignRules(value, currentStock, campaignId) {
    const text = String(value || '');
    const stock = String(currentStock || '');
    if (!stock || text === stock) return text;
    const legacyId = LEGACY_CAMPAIGN_RULES.get(fingerprint(text));
    if (legacyId && legacyId === String(campaignId || '') && stock.includes(MEDICARE_RULE_MARKER)) return stock;
    return text;
  }

  return {
    composeBehavioralPrompt,
    conversationIntegrityLines,
    callEndingLines,
    backgroundVoiceLines,
    callTimeLimitLines,
    humanSpeechLines,
    migrateLegacyQualificationPrompt,
    migrateLegacyCampaignRules,
    defaultSelfIntro,
    migrateLegacySelfIntro,
    createConversationMemory,
    fingerprint,
    TONE_MAP,
    MAX_PROMPT_LENGTH,
    MAX_CAMPAIGN_RULES,
    MED_BENEFITS_RULE_MARKER,
  };
});
