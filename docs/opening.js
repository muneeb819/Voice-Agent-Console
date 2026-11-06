/* Shared opening composition and timing for the server and static browser. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VacOpening = api;
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';

  const OPENING_DELAY_MS = 500;
  const NO_TRANSCRIPT_FALLBACK_MS = 2500;
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
      const instruction = '\n\n[Opening turn] If the caller speaks before the opening, respond to their actual words. ' +
        'When appropriate, begin the first response with this one opening only, without a second greeting or repeated introduction: ' +
        JSON.stringify(greeting) +
        '. Honor requests to stop, urgent concerns, and other safety instructions rather than insisting on a scripted greeting. ' +
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
   * Keep output silent for 500 ms after SettingsApplied while input keeps
   * flowing. If the caller speaks first, let the provider answer that turn;
   * do not inject a second greeting on top of its response.
   */
  function createOpeningGate(options) {
    let released = false, started = false, stopped = false;
    let callerStarted = false, callerTurn = false, agentTurn = false, injected = false;
    let delayTimer = null, fallbackTimer = null, queuedBytes = 0, overflowReported = false;
    const queuedAudio = [];
    const releaseCallbacks = [];

    function clearFallback() {
      if (fallbackTimer !== null) clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
    function injectOnce() {
      if (stopped || injected || callerTurn || agentTurn || !options.greeting) return;
      injected = true;
      options.sendOpening(options.greeting);
    }
    function scheduleNoiseFallback() {
      if (stopped || injected || callerTurn || agentTurn || fallbackTimer !== null || !callerStarted) return;
      // A VAD onset can be background noise and never become a transcript.
      // The provider's default injection mode will refuse rather than interrupt
      // if somebody is still speaking at this point.
      fallbackTimer = setTimeout(() => { fallbackTimer = null; injectOnce(); }, NO_TRANSCRIPT_FALLBACK_MS);
    }
    return {
      start() {
        if (started || stopped) return;
        started = true;
        delayTimer = setTimeout(() => {
          delayTimer = null;
          if (stopped) return;
          released = true;
          if (!callerStarted && !agentTurn) injectOnce();
          else scheduleNoiseFallback();
          while (queuedAudio.length && !stopped) options.playAudio(queuedAudio.shift());
          queuedBytes = 0;
          while (releaseCallbacks.length && !stopped) releaseCallbacks.shift()();
        }, OPENING_DELAY_MS);
      },
      userStarted() {
        if (stopped) return;
        callerStarted = true;
        // Do not release speech that the caller interrupted during the wait.
        queuedAudio.length = 0;
        queuedBytes = 0;
        if (released) scheduleNoiseFallback();
      },
      userTurn() {
        callerStarted = true;
        callerTurn = true;
        clearFallback();
      },
      agentTurn() {
        agentTurn = true;
        clearFallback();
      },
      audio(chunk) {
        if (stopped) return;
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
        if (delayTimer !== null) clearTimeout(delayTimer);
        delayTimer = null;
        clearFallback();
        queuedAudio.length = 0;
        releaseCallbacks.length = 0;
        queuedBytes = 0;
      },
    };
  }

  return { OPENING_DELAY_MS, migrateStockOpening, migrateStockMedicarePrompt, composeOpening, prepareDelayedOpening, createOpeningGate };
});
