/* Shared opening composition and timing for the server and static browser. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VacOpening = api;
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';

  const OPENING_DELAY_MS = 1000;
  const NO_TRANSCRIPT_FALLBACK_MS = 2500;
  const PRESENCE_PROMPT_TIMEOUT_MS = 15000;
  const DEFAULT_PRESENCE_CHECK_TEXT = 'Hello? Are you there? Can you hear me?';
  const MAX_EARLY_AUDIO_BYTES = 256 * 1024;
  const salutations = ['Hi', 'Hello', 'Hi there', 'Hello there', 'Hey there'];
  const questions = [
    'How are you doing today?',
    'How is your day going?',
    "How's your day going so far?",
    "How's everything going?",
    'How are things going today?',
    'How has your day been?',
    "How's everything going with you today?",
    'How are you today?',
    'How has your day been treating you?',
    'How are things going for you?',
  ];

  const stockOpenings = new Map([
    [
      'Hi, this is Haley calling from the Benefits Department. Your new food and OTC card is on hold right now, loaded with funds for groceries and dental. If unclaimed today, it gets returned to the state pool. To release your card immediately, do you have Medicare Part A and B?',
      'Hi, this is Haley calling from the Benefits Department. How are you doing today?',
    ],
    [
      "Hey there! This is Nova on the line — how are you doing today? Feel free to ask me anything at all, I'm right here to help!",
      'Hey there! This is Nova on the line. How are you doing today?',
    ],
  ]);

  // Only replace exact built-in samples, never truncate a customized opening.
  function migrateStockOpening(value) {
    const text = String(value || '');
    return stockOpenings.get(text) || text;
  }

  const oldMedicarePhase = '- Phase 1 (Delivered in Greeting — Food & OTC Card Hook):\n' +
    '  You already asked if they have Medicare Part A and B to release their Food & OTC card.\n';
  const correctedMedicarePhase = '- Phase 1 (After the opening):\n' +
    '  If Medicare status has not been established, ask whether they have Medicare Part A or Part B; do not assume the opening asked this.\n';

  // Fix the built-in prompt's outdated assumption only when the *entire*
  // prompt matches the old stock text. Customized prompts remain untouched.
  function migrateStockMedicarePrompt(value, correctedStockPrompt) {
    const text = String(value || '');
    const stock = String(correctedStockPrompt || '');
    if (!stock.includes(correctedMedicarePhase)) return text;
    const oldStock = stock.replace(correctedMedicarePhase, oldMedicarePhase);
    return text === oldStock ? stock : text;
  }

  function hashText(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  /** Vary a saved opening, never append an entire second imported greeting. */
  function composeOpening(savedOpening, variationText, includeDisclosure, disclosure) {
    let result = String(savedOpening || '').trim();
    const variation = String(variationText || '').trim();
    if (result && variation) {
      const hash = hashText(variation);
      const sourceStart = variation.match(/^\s*([^.!?]+)[.!?]/)?.[1]?.trim().toLowerCase() || '';
      const sourceSalutations = {
        'hello': 'Hello', 'hey there': 'Hey there', 'hello there, friend': 'Hello there',
        'hiya': 'Hiya', 'howdy': 'Howdy',
      };
      const salutation = sourceSalutations[sourceStart] || salutations[hash % salutations.length];
      const safeQuestion = /\bhow(?:'s|’s| is)\s+(?:everything|your\s+day|things|it)\b[^?!.]{0,100}\?|\bhow\s+(?:are|have|has)\s+(?:you|your\s+day|things)\b[^?!.]{0,100}\?/i;
      const sourceQuestion = variation.match(safeQuestion)?.[0];
      const question = sourceQuestion
        ? sourceQuestion[0].toUpperCase() + sourceQuestion.slice(1)
        : questions[(hash >>> 8) % questions.length];
      // Only replace recognized salutations; never invent or rewrite an identity,
      // organization, benefit, or other substantive part of the saved opening.
      result = result.replace(
        /^(?:hi|hello+|hell+o+|hey(?:\s+there)?|hiya|howdy|good\s+(?:morning|afternoon|evening))\b([!,.:]?\s+)/i,
        (_match, separator) => `${salutation}${separator}`
      );
      const generalQuestion = /\bhow(?:'s|’s| is)\s+(?:everything|your\s+day|things|it)\b[^?!.]{0,100}\?|\bhow\s+(?:are|have|has)\s+(?:you|your\s+day|things)\b[^?!.]{0,100}\?/i;
      if (generalQuestion.test(result)) {
        result = result.replace(generalQuestion, question);
      } else if (!result.includes('?') && result.length <= 180) {
        // A short saved introduction may omit its question. Do not tack another
        // question onto an existing qualification or other substantive question.
        result = `${result.replace(/\s+$/, '')} ${question}`;
      }
    }
    const notice = String(disclosure || '').trim();
    if (includeDisclosure && notice && !result.toLocaleLowerCase().includes(notice.toLocaleLowerCase())) {
      result = `${notice} ${result}`.trim();
    }
    return result;
  }

  /** Deepgram Settings is sent immediately, without its automatic greeting. */
  function prepareDelayedOpening(settings) {
    const wire = JSON.parse(JSON.stringify(settings));
    const greeting = String(wire?.agent?.greeting || '').trim();
    if (!wire.agent || !wire.agent.think) throw new Error('Agent settings are incomplete.');
    delete wire.agent.greeting;
    if (greeting) {
      const instruction = '\n\n[Call opening sequence] The bridge listens for the caller’s first speech for one full second before the bot speaks. ' +
        'If the caller speaks during that listen, respond to their actual words and begin the assigned campaign greeting naturally in the first response when appropriate. ' +
        'If the caller is silent, the bridge sends one short campaign presence-check line; say that line only, then wait for the caller. ' +
        'When the caller answers the presence check, begin this one assigned campaign opening without repeating the check or adding a second greeting: ' +
        JSON.stringify(greeting) +
        '. Honor requests to stop, urgent concerns, and other safety instructions instead of insisting on a script. ' +
        'Never assume an eligibility question was asked or answered unless it actually appears in the conversation.';
      const prompt = String(wire.agent.think.prompt || '');
      if (prompt.length + instruction.length > 25000) {
        throw new Error('The agent prompt is too long to add opening-turn instructions. Shorten it before starting a call.');
      }
      wire.agent.think.prompt = prompt + instruction;
    }
    return { settings: wire, greeting };
  }

  /**
   * Hold all bot audio for one second while caller audio continues upstream.
   * If no speech starts, ask one brief campaign presence check. Only a caller
   * turn (not VAD noise or bot audio) satisfies that check; silence after the
   * check invokes the dead-air disposition/hangup callback exactly once.
   */
  function createOpeningGate(options) {
    let released = false, started = false, stopped = false;
    let callerStarted = false, callerTurn = false, presenceSent = false;
    let phase = 'initial';
    let delayTimer = null, fallbackTimer = null, promptTimer = null, responseTimer = null;
    let queuedBytes = 0, overflowReported = false;
    const queuedAudio = [];
    const releaseCallbacks = [];
    const presenceText = String(options.presenceCheck || DEFAULT_PRESENCE_CHECK_TEXT).trim();
    const responseTimeoutMs = Math.max(1, Number(options.responseTimeoutMs) || 8000);
    const promptTimeoutMs = Math.max(1, Number(options.presencePromptTimeoutMs) || PRESENCE_PROMPT_TIMEOUT_MS);

    function clearTimer(name) {
      if (name === 'delay' && delayTimer !== null) clearTimeout(delayTimer);
      if (name === 'fallback' && fallbackTimer !== null) clearTimeout(fallbackTimer);
      if (name === 'prompt' && promptTimer !== null) clearTimeout(promptTimer);
      if (name === 'response' && responseTimer !== null) clearTimeout(responseTimer);
      if (name === 'delay') delayTimer = null;
      if (name === 'fallback') fallbackTimer = null;
      if (name === 'prompt') promptTimer = null;
      if (name === 'response') responseTimer = null;
    }
    function clearQueuedAudio() {
      queuedAudio.length = 0;
      queuedBytes = 0;
    }
    function markDeadAir() {
      if (stopped || phase === 'dead_air' || phase === 'answered') return;
      phase = 'dead_air';
      clearTimer('delay');
      clearTimer('fallback');
      clearTimer('prompt');
      clearTimer('response');
      clearQueuedAudio();
      try { if (typeof options.onDeadAir === 'function') options.onDeadAir(); } catch {}
    }
    function startResponseTimer() {
      clearTimer('response');
      if (stopped || phase !== 'waiting_response') return;
      responseTimer = setTimeout(() => {
        responseTimer = null;
        markDeadAir();
      }, responseTimeoutMs);
    }
    function sendPresenceCheck() {
      if (stopped || presenceSent || callerTurn || (phase !== 'initial' && phase !== 'awaiting_first_turn')) return;
      presenceSent = true;
      phase = 'presence_prompt';
      callerStarted = false;
      clearTimer('fallback');
      clearQueuedAudio();
      if (!presenceText || typeof options.sendPresenceCheck !== 'function') {
        markDeadAir();
        return;
      }
      try {
        options.sendPresenceCheck(presenceText);
      } catch {
        markDeadAir();
        return;
      }
      promptTimer = setTimeout(() => {
        promptTimer = null;
        markDeadAir();
      }, promptTimeoutMs);
    }
    function scheduleNoiseFallback() {
      if (stopped || callerTurn || phase !== 'awaiting_first_turn' || fallbackTimer !== null || !callerStarted) return;
      // Give a short caller utterance time to reach end-of-turn transcription
      // before deciding a VAD onset was noise.
      fallbackTimer = setTimeout(() => {
        fallbackTimer = null;
        sendPresenceCheck();
      }, NO_TRANSCRIPT_FALLBACK_MS);
    }
    function releaseOutput() {
      if (released || stopped) return;
      released = true;
      if (phase === 'initial') {
        if (callerStarted) {
          phase = 'awaiting_first_turn';
          scheduleNoiseFallback();
        } else {
          // Never let unsolicited provider audio race the one-time presence check.
          clearQueuedAudio();
          sendPresenceCheck();
        }
      }
      while (queuedAudio.length && !stopped && phase !== 'dead_air') options.playAudio(queuedAudio.shift());
      queuedBytes = 0;
      while (releaseCallbacks.length && !stopped) releaseCallbacks.shift()();
    }
    return {
      start() {
        if (started || stopped) return;
        started = true;
        delayTimer = setTimeout(() => {
          delayTimer = null;
          releaseOutput();
        }, OPENING_DELAY_MS);
      },
      userStarted() {
        if (stopped || phase === 'dead_air' || phase === 'answered') return;
        callerStarted = true;
        if (!released) {
          // Discard any generated audio tied to a stale/partial pre-listen turn.
          clearQueuedAudio();
        }
        if (phase === 'awaiting_first_turn') scheduleNoiseFallback();
        if (phase === 'presence_prompt') {
          clearTimer('prompt');
          phase = 'waiting_response';
          startResponseTimer();
        } else if (phase === 'waiting_response') {
          // A response may take several seconds to finish transcribing.
          startResponseTimer();
        }
      },
      userTurn() {
        if (stopped || phase === 'dead_air') return;
        callerStarted = true;
        callerTurn = true;
        phase = 'answered';
        clearTimer('fallback');
        clearTimer('prompt');
        clearTimer('response');
      },
      agentTurn() {
        // Agent speech is never evidence that the caller answered the check.
      },
      agentAudioDone() {
        if (stopped || phase !== 'presence_prompt') return;
        clearTimer('prompt');
        phase = 'waiting_response';
        startResponseTimer();
      },
      audio(chunk) {
        if (stopped || phase === 'dead_air') return;
        if (released) { options.playAudio(chunk); return; }
        const size = Number(chunk?.byteLength ?? chunk?.length ?? 0);
        if (size >= 0 && queuedBytes + size <= MAX_EARLY_AUDIO_BYTES) {
          queuedBytes += size;
          queuedAudio.push(chunk);
        } else if (!overflowReported && options.onOverflow) {
          overflowReported = true;
          options.onOverflow();
        }
      },
      afterRelease(callback) {
        if (stopped) return;
        if (released) callback();
        else releaseCallbacks.push(callback);
      },
      cancel() {
        if (stopped) return;
        stopped = true;
        clearTimer('delay');
        clearTimer('fallback');
        clearTimer('prompt');
        clearTimer('response');
        clearQueuedAudio();
        releaseCallbacks.length = 0;
      },
    };
  }

  return { OPENING_DELAY_MS, NO_TRANSCRIPT_FALLBACK_MS, PRESENCE_PROMPT_TIMEOUT_MS, DEFAULT_PRESENCE_CHECK_TEXT, migrateStockOpening, migrateStockMedicarePrompt, composeOpening, prepareDelayedOpening, createOpeningGate };
});
