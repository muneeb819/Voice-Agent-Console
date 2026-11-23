// Phrase rules that classify what the far end said. Phrases are matched on
// normalised text (lowercase, digits kept, punctuation removed).

export type TranscriptCue = 'VOICEMAIL' | 'IVR' | 'PRERECORDED_AUDIO';

const RULES: Array<{ cue: TranscriptCue; label: string; pattern: RegExp }> = [
  // Network / carrier announcements and recorded messages.
  { cue: 'PRERECORDED_AUDIO', label: 'number not in service', pattern: /\b(is not in service|no longer in service|has been disconnected|not a working number|cannot be completed as dialed|could not be completed|call cannot be completed|please check the number and dial again|the number you have (dialed|called|reached)|the (subscriber|customer|mobile customer|person) you (have )?(called|dialed|are calling) is (not available|unavailable)|please try your call again later|all circuits are busy)\b/ },
  { cue: 'PRERECORDED_AUDIO', label: 'recorded message', pattern: /\b(this is a (pre)?recorded (message|call)|this message (is|was) recorded|this is an automated (message|call))\b/ },
  // Menus, assistants and call screening services.
  { cue: 'IVR', label: 'phone menu', pattern: /\b(press (1|2|3|4|5|6|7|8|9|0|one|two|three|four|five|six|seven|eight|nine|zero|pound|star)|para espanol|para español|main menu|please listen carefully|menu options have changed|dial by name|enter (the|your) (extension|party)|if you know your party|your call is (very )?important|please (stay on the line|hold)|for quality (and|or) training purposes)\b/ },
  { cue: 'IVR', label: 'call screening assistant', pattern: /\b(using a (call )?screening service|screening service from google|say your name and why you('re| are) calling|state your name and (the )?reason|the person you('re| are) calling is using|go ahead and say your name)\b/ },
  // Voicemail greetings.
  { cue: 'VOICEMAIL', label: 'voicemail greeting', pattern: /\b(leave (me |us )?(a|your) (brief |short )?(message|name and number|voicemail)|after the (tone|beep)|at the (tone|beep)|record your message|not available (right now|to take your call|at the moment)|unavailable to take your call|can('t| ?not) (come to|take) (the|your) (phone|call)|(has|have) a (full )?mailbox|mailbox (is full|has not been set up)|voice ?mail|you have reached|you('ve| have) reached the (voicemail|mailbox)|i('ll| will) (call|get back to) you (back|as soon as possible)|get back to you as soon as|forwarded to an automatic voice message system|when you have finished recording|hang up or press)\b/ },
];

export function normaliseTranscript(text: string): string {
  return String(text || '')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9ñ' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function wordCount(text: string): number {
  const t = normaliseTranscript(text);
  return t ? t.split(' ').length : 0;
}

export function matchTranscriptCue(text: string): { cue: TranscriptCue; label: string } | null {
  const norm = normaliseTranscript(text);
  if (!norm) return null;
  for (const rule of RULES) {
    if (rule.pattern.test(norm)) return { cue: rule.cue, label: rule.label };
  }
  return null;
}
