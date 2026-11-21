"use strict";
// Shared by the VICIdial bridge and the Live Bot simulator.
Object.defineProperty(exports, "__esModule", { value: true });
exports.TRANSFER_INTENT_AUTOCOMPLETE_MS = exports.TRANSFER_INTENT_GRACE_MS = exports.CALL_LIMIT_CLOSING_LINE = void 0;
exports.callLimitMsForCampaign = callLimitMsForCampaign;
exports.callLimitSchedule = callLimitSchedule;
exports.callLimitWrapUpPrompt = callLimitWrapUpPrompt;
exports.announcesTransfer = announcesTransfer;
exports.transferBlockedPrompt = transferBlockedPrompt;
/** Per-campaign hard call-length limit in ms (0 = no limit). */
function callLimitMsForCampaign(campaign) {
    const sec = Number(campaign?.maxCallSec ?? 0);
    return Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : 0;
}
/** When to nudge the bot to wrap up and when to speak the closing line. */
function callLimitSchedule(limitMs) {
    const wrapUpAtMs = Math.max(limitMs - 20000, Math.round(limitMs * 0.6));
    const closingAtMs = Math.max(limitMs - 6000, wrapUpAtMs + 1000);
    return { wrapUpAtMs, closingAtMs };
}
exports.CALL_LIMIT_CLOSING_LINE = "I'm sorry, I have to let you go now. Thank you for your time, and have a great day!";
function callLimitWrapUpPrompt(secondsLeft) {
    return [
        `TIME CHECK: about ${secondsLeft} seconds remain before this call ends automatically.`,
        'Wrap up NOW, warmly and without sounding rushed. If the caller is interested and qualified (or already agreed), say one short, happy handoff line and call set_disposition with "XFER" and transfer_to_live_agent in the same turn, without any more questions. An interested caller must be transferred, never let go.',
        'If one single answer is still needed to qualify, ask only that one short question.',
        'Otherwise say one short, polite closing sentence, record the matching allowed disposition, and call end_call.',
    ].join(' ');
}
/**
 * The bot telling the caller it is connecting them RIGHT NOW ("Please hold
 * while I connect you", "I'll transfer you now"). An offer or a question
 * ("Would you like me to connect you?") does not count.
 *
 * Why: bots sometimes announce the transfer but never call
 * transfer_to_live_agent; the call-length limit then hung up on an interested,
 * qualified caller mid-handoff. Once announced, the call is protected and the
 * bridge completes the transfer itself (through the same qualification gate).
 */
function announcesTransfer(text) {
    const t = String(text || '').toLowerCase().replace(/[’']/g, "'");
    const sentences = t.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
    return sentences.some((s) => {
        if (s.endsWith('?'))
            return false;
        if (/\b(?:would you like|do you want|want me to|shall i|should i|can i|may i|if you(?:'d| would)? like|if that's okay|are you interested|would that be|happy to connect you if)\b/.test(s))
            return false;
        return /\b(?:i(?:'ll| will| am|'m) (?:now )?(?:connect|connecting|transfer|transferring|put(?:ting)? you through|bring(?:ing)?)|let me (?:connect|transfer|get you over|put you through|bring)|(?:connecting|transferring) you(?: now| over| right now)?|(?:please )?(?:hold|stay on) (?:the line|on|for (?:just )?(?:a|one) (?:moment|second|sec))[^.!]*(?:connect|transfer|specialist|agent|representative|licensed)|one moment while i (?:connect|transfer|get)|i'm (?:getting|bringing) (?:a|our|my|one of our) (?:licensed )?(?:specialist|agent|representative))/.test(s);
    });
}
/** How long an announced transfer protects the call from the call-length limit. */
exports.TRANSFER_INTENT_GRACE_MS = 45000;
/** After the announcement finishes playing, wait this long for the bot's own transfer call. */
exports.TRANSFER_INTENT_AUTOCOMPLETE_MS = 1800;
function transferBlockedPrompt(blockers) {
    return [
        'TRANSFER NOT STARTED: you told the caller you are connecting them, but the transfer cannot start yet because:',
        blockers.join(' '),
        'Apologize briefly and warmly, ask only for the missing detail in one short question, then call transfer_to_live_agent once you have it.',
    ].join(' ');
}
