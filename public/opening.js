/* Shared opening composition and timing for the server and static browser. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VacOpening = api;
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';

  const OPENING_DELAY_MS = 1000;
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
      const instruction = '\n\n[Call opening sequence] The bridge listens for the caller’s first speech for one full second before the bot speaks. ' +
        'If the caller speaks during that listen, respond to their actual words and begin the assigned campaign greeting naturally in the first response when appropriate. ' +
        'If the caller is silent, the bridge injects this one assigned campaign opening; say it once, then listen for the caller. ' +
        'Do not repeat it or end the call merely because the caller is silent. The assigned opening is: ' +
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
   * Hold bot output for one second while caller audio continues upstream.
   * A completed caller turn takes priority. Otherwise inject the configured
   * opening once (with a bounded grace period for an unfinished VAD onset).
   * There is no silence-triggered hangup or disposition path.
   */
  function createOpeningGate(options) {
    let started = false, stopped = false, listenComplete = false, outputReleased = false;
    let callerStarted = false, callerTurn = false, openingSent = false;
    let delayTimer = null, fallbackTimer = null;
    let queuedBytes = 0, overflowReported = false;
    const queuedAudio = [];
    const releaseCallbacks = [];
    const greeting = String(options.greeting || '').trim();

    function clearTimers() {
      if (delayTimer !== null) clearTimeout(delayTimer);
      if (fallbackTimer !== null) clearTimeout(fallbackTimer);
      delayTimer = null;
      fallbackTimer = null;
    }
    function clearQueuedAudio() {
      queuedAudio.length = 0;
      queuedBytes = 0;
    }
    function releaseOutput() {
      if (outputReleased || stopped || !listenComplete || (!callerTurn && !openingSent)) return;
      outputReleased = true;
      while (queuedAudio.length && !stopped) options.playAudio(queuedAudio.shift());
      queuedBytes = 0;
      while (releaseCallbacks.length && !stopped) releaseCallbacks.shift()();
    }
    function sendConfiguredOpening() {
      if (stopped || callerTurn || openingSent) return;
      openingSent = true;
      if (fallbackTimer !== null) clearTimeout(fallbackTimer);
      fallbackTimer = null;
      // Unsolicited provider audio must not race or replace the saved opening.
      clearQueuedAudio();
      if (greeting && typeof options.sendOpening === 'function') {
        try { options.sendOpening(greeting); }
        catch (error) {
          try { if (typeof options.onSendError === 'function') options.onSendError(error); } catch {}
        }
      }
      releaseOutput();
    }
    function scheduleTranscriptGrace() {
      if (stopped || callerTurn || openingSent || fallbackTimer !== null || !callerStarted || !listenComplete) return;
      // This only gives an already-started utterance time to transcribe. It
      // never terminates a call; its expiry releases the configured opening.
      fallbackTimer = setTimeout(() => {
        fallbackTimer = null;
        sendConfiguredOpening();
      }, NO_TRANSCRIPT_FALLBACK_MS);
    }
    function completeListen() {
      if (stopped || listenComplete) return;
      listenComplete = true;
      if (callerTurn) releaseOutput();
      else if (callerStarted) scheduleTranscriptGrace();
      else sendConfiguredOpening();
    }
    return {
      start() {
        if (started || stopped) return;
        started = true;
        delayTimer = setTimeout(() => {
          delayTimer = null;
          completeListen();
        }, OPENING_DELAY_MS);
      },
      userStarted() {
        if (stopped || callerTurn) return;
        callerStarted = true;
        if (!outputReleased) clearQueuedAudio();
        scheduleTranscriptGrace();
      },
      userTurn() {
        if (stopped) return;
        callerStarted = true;
        callerTurn = true;
        if (fallbackTimer !== null) clearTimeout(fallbackTimer);
        fallbackTimer = null;
        releaseOutput();
      },
      audio(chunk) {
        if (stopped) return;
        if (outputReleased) { options.playAudio(chunk); return; }
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
        if (outputReleased) callback();
        else releaseCallbacks.push(callback);
      },
      cancel() {
        if (stopped) return;
        stopped = true;
        clearTimers();
        clearQueuedAudio();
        releaseCallbacks.length = 0;
      },
    };
  }

  return { OPENING_DELAY_MS, NO_TRANSCRIPT_FALLBACK_MS, migrateStockOpening, migrateStockMedicarePrompt, composeOpening, prepareDelayedOpening, createOpeningGate };
});
