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
/** Matches REFER responses to the waiting transfer. One tracker per SIP socket. */
class ReferTracker {
    pending = new Map();
    key(callId, cseq) {
        return `${callId}|${cseq}`;
    }
    /**
     * Resolves with the dialer's answer, or a failure when none arrives in time.
     * `send` is called once immediately and once more after `retryMs` if there is
     * still no answer, because the request travels over UDP.
     */
    wait(callId, cseq, send, timeoutMs = 5000, retryMs = 1000) {
        const key = this.key(callId, cseq);
        return new Promise((resolve) => {
            let retryTimer = null;
            let timeoutTimer = null;
            const finish = (result) => {
                if (retryTimer)
                    clearTimeout(retryTimer);
                if (timeoutTimer)
                    clearTimeout(timeoutTimer);
                this.pending.delete(key);
                resolve(result);
            };
            this.pending.set(key, finish);
            try {
                send();
            }
            catch (err) {
                finish({ ok: false, message: `REFER could not be sent: ${err?.message || 'unknown error'}` });
                return;
            }
            retryTimer = setTimeout(() => {
                if (!this.pending.has(key))
                    return;
                try {
                    send();
                }
                catch { }
            }, retryMs);
            timeoutTimer = setTimeout(() => finish({ ok: false, message: 'REFER timed out: no answer from the dialer' }), timeoutMs);
        });
    }
    /** Feed every SIP response the socket receives; returns true when it belonged to a waiting REFER. */
    handleResponse(callId, cseqHeader, startLine) {
        const cseq = parseCseqHeader(cseqHeader);
        const status = parseSipResponseLine(startLine);
        if (!cseq || !status || cseq.method !== 'REFER')
            return false;
        const finish = this.pending.get(this.key(callId, cseq.num));
        if (!finish)
            return false;
        const outcome = referOutcome(status.status);
        if (outcome === 'pending')
            return true;
        finish({
            ok: outcome === 'accepted',
            message: `${status.status} ${status.reason}`.trim(),
        });
        return true;
    }
    /** Drops a waiting REFER when its call ends. */
    cancel(callId, reason = 'call ended before the dialer answered the REFER') {
        for (const [key, finish] of Array.from(this.pending.entries())) {
            if (key.startsWith(`${callId}|`))
                finish({ ok: false, message: reason });
        }
    }
}
exports.ReferTracker = ReferTracker;
