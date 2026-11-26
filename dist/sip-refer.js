"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReferTracker = void 0;
exports.sanitizeReferTarget = sanitizeReferTarget;
exports.buildReferRequest = buildReferRequest;
exports.parseSipResponseLine = parseSipResponseLine;
exports.parseCseqHeader = parseCseqHeader;
exports.referOutcome = referOutcome;
exports.parseSipfragStatus = parseSipfragStatus;
const crypto_1 = __importDefault(require("crypto"));
/** Dialplan extensions are digits, letters and a few symbols; anything else could inject SIP headers. */
function sanitizeReferTarget(raw) {
    const target = String(raw ?? '').trim();
    return /^[0-9A-Za-z*#+_-]{1,32}$/.test(target) ? target : null;
}
/** A host or IPv4/IPv6 literal, never anything that could carry header separators. */
function isSafeHost(host) {
    return /^[0-9A-Za-z.:\-\[\]]{1,255}$/.test(host);
}
function buildReferRequest(input) {
    const target = sanitizeReferTarget(input.target);
    if (!target)
        throw new Error('REFER target is not a valid dialplan extension.');
    if (!isSafeHost(input.referHost) || !isSafeHost(input.localHost))
        throw new Error('REFER host is not valid.');
    for (const value of [input.remoteContactUri, input.fromHeader, input.toHeader, input.callId, input.contactUser]) {
        if (/[\r\n\x00]/.test(String(value)))
            throw new Error('REFER header value contains a line break.');
    }
    const branch = `z9hG4bK${crypto_1.default.randomBytes(5).toString('hex')}`;
    const message = [
        `REFER ${input.remoteContactUri} SIP/2.0`,
        `Via: SIP/2.0/UDP ${input.localHost}:${input.localPort};branch=${branch};rport`,
        'Max-Forwards: 70',
        `From: ${input.fromHeader}`,
        `To: ${input.toHeader}`,
        `Call-ID: ${input.callId}`,
        `CSeq: ${input.cseq} REFER`,
        `Contact: <sip:${input.contactUser}@${input.localHost}:${input.localPort}>`,
        `Refer-To: <sip:${target}@${input.referHost}>`,
        `Referred-By: <sip:bridge@${input.localHost}>`,
        'Content-Length: 0',
        '',
        '',
    ].join('\r\n');
    return { message, branch };
}
function parseSipResponseLine(startLine) {
    const match = /^SIP\/2\.0\s+(\d{3})\s*(.*)$/i.exec(String(startLine || '').trim());
    if (!match)
        return null;
    return { status: Number(match[1]), reason: match[2].trim() };
}
function parseCseqHeader(value) {
    const match = /^\s*(\d+)\s+([A-Za-z]+)\s*$/.exec(String(value || ''));
    if (!match)
        return null;
    return { num: Number(match[1]), method: match[2].toUpperCase() };
}
/** 1xx keeps waiting, 2xx means the dialer accepted the transfer, anything else is a refusal. */
function referOutcome(status) {
    if (status >= 100 && status < 200)
        return 'pending';
    if (status >= 200 && status < 300)
        return 'accepted';
    return 'failed';
}
/** Final status of a REFER, taken from the sipfrag body of a NOTIFY (Event: refer). */
function parseSipfragStatus(body) {
    const line = String(body || '').split(/\r?\n/).find((l) => /^SIP\/2\.0\s+\d{3}/i.test(l.trim()));
    return line ? parseSipResponseLine(line) : null;
}
/**
 * Matches REFER responses and NOTIFYs to the waiting transfer. One tracker per SIP socket.
 * A 2xx to REFER only means "request accepted"; the transfer has succeeded only when a
 * NOTIFY reports a final 2xx (or the dialer releases our leg after accepting).
 */
class ReferTracker {
    pending = new Map();
    key(callId, cseq) {
        return `${callId}|${cseq}`;
    }
    wait(callId, cseq, send, timeoutMs = 5000, retryMs = 1000, notifyTimeoutMs = 8000) {
        const key = this.key(callId, cseq);
        return new Promise((resolve) => {
            let retryTimer = null;
            let timeoutTimer = null;
            const settle = (result) => {
                if (retryTimer)
                    clearTimeout(retryTimer);
                if (timeoutTimer)
                    clearTimeout(timeoutTimer);
                this.pending.delete(key);
                resolve(result);
            };
            const entry = {
                settle,
                accepted: false,
                armNotifyWait: () => {
                    if (retryTimer)
                        clearTimeout(retryTimer);
                    if (timeoutTimer)
                        clearTimeout(timeoutTimer);
                    timeoutTimer = setTimeout(() => settle({ ok: false, message: 'REFER accepted but the dialer never reported the transfer result' }), notifyTimeoutMs);
                },
            };
            this.pending.set(key, entry);
            try {
                send();
            }
            catch (err) {
                settle({ ok: false, message: `REFER could not be sent: ${err?.message || 'unknown error'}` });
                return;
            }
            retryTimer = setTimeout(() => {
                if (!this.pending.has(key) || entry.accepted)
                    return;
                try {
                    send();
                }
                catch { }
            }, retryMs);
            timeoutTimer = setTimeout(() => settle({ ok: false, message: 'REFER timed out: no answer from the dialer' }), timeoutMs);
        });
    }
    /** Feed every SIP response from a trusted peer; returns true when it belonged to a waiting REFER. */
    handleResponse(callId, cseqHeader, startLine) {
        const cseq = parseCseqHeader(cseqHeader);
        const status = parseSipResponseLine(startLine);
        if (!cseq || !status || cseq.method !== 'REFER')
            return false;
        const entry = this.pending.get(this.key(callId, cseq.num));
        if (!entry)
            return false;
        const outcome = referOutcome(status.status);
        if (outcome === 'pending')
            return true;
        if (outcome === 'failed') {
            entry.settle({ ok: false, message: `${status.status} ${status.reason}`.trim() });
            return true;
        }
        if (!entry.accepted) {
            entry.accepted = true;
            entry.armNotifyWait();
        }
        return true;
    }
    /** Feed a NOTIFY (Event: refer) body; a final status settles the transfer. */
    handleNotify(callId, body) {
        const frag = parseSipfragStatus(body);
        if (!frag)
            return false;
        for (const [key, entry] of Array.from(this.pending.entries())) {
            if (!key.startsWith(`${callId}|`) || !entry.accepted)
                continue;
            const outcome = referOutcome(frag.status);
            if (outcome === 'pending')
                return true;
            entry.settle({ ok: outcome === 'accepted', message: `transfer ${frag.status} ${frag.reason}`.trim() });
            return true;
        }
        return false;
    }
    /**
     * Called when the call ends. If the dialer had accepted the REFER, it released our leg
     * to complete the transfer, which counts as success; otherwise the wait fails.
     */
    cancel(callId, reason = 'call ended before the dialer answered the REFER') {
        for (const [key, entry] of Array.from(this.pending.entries())) {
            if (!key.startsWith(`${callId}|`))
                continue;
            if (entry.accepted)
                entry.settle({ ok: true, message: 'dialer released the call after accepting the REFER' });
            else
                entry.settle({ ok: false, message: reason });
        }
    }
}
exports.ReferTracker = ReferTracker;
