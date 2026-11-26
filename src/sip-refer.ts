import crypto from 'crypto';

/**
 * SIP REFER (blind transfer) helpers for the bridge.
 *
 * Used as a backup when VICIdial's Agent API and Asterisk AMI cannot move a
 * call: the bridge asks the dialer, inside the INVITE dialog it already holds,
 * to send the caller to a dialplan extension. It needs no extra port; it uses
 * the SIP path the call already arrived on.
 */

export interface ReferResult {
  ok: boolean;
  message: string;
}

export interface ReferRequestInput {
  /** Request-URI: the Contact the dialer gave in its INVITE. */
  remoteContactUri: string;
  /** Host and port the dialer should use to reach the bridge (Via and Contact). */
  localHost: string;
  localPort: number;
  /** Our dialog identity, exactly as used for BYE: From carries our tag, To is the dialer's From. */
  fromHeader: string;
  toHeader: string;
  callId: string;
  cseq: number;
  /** User part of our Contact URI. */
  contactUser: string;
  /** Dialplan extension the dialer should send the caller to. */
  target: string;
  /** Host that goes into Refer-To (the dialer). */
  referHost: string;
}

/** Dialplan extensions are digits, letters and a few symbols; anything else could inject SIP headers. */
export function sanitizeReferTarget(raw: string): string | null {
  const target = String(raw ?? '').trim();
  return /^[0-9A-Za-z*#+_-]{1,32}$/.test(target) ? target : null;
}

/** A host or IPv4/IPv6 literal, never anything that could carry header separators. */
function isSafeHost(host: string): boolean {
  return /^[0-9A-Za-z.:\-\[\]]{1,255}$/.test(host);
}

export function buildReferRequest(input: ReferRequestInput): { message: string; branch: string } {
  const target = sanitizeReferTarget(input.target);
  if (!target) throw new Error('REFER target is not a valid dialplan extension.');
  if (!isSafeHost(input.referHost) || !isSafeHost(input.localHost)) throw new Error('REFER host is not valid.');
  for (const value of [input.remoteContactUri, input.fromHeader, input.toHeader, input.callId, input.contactUser]) {
    if (/[\r\n\x00]/.test(String(value))) throw new Error('REFER header value contains a line break.');
  }
  const branch = `z9hG4bK${crypto.randomBytes(5).toString('hex')}`;
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

export function parseSipResponseLine(startLine: string): { status: number; reason: string } | null {
  const match = /^SIP\/2\.0\s+(\d{3})\s*(.*)$/i.exec(String(startLine || '').trim());
  if (!match) return null;
  return { status: Number(match[1]), reason: match[2].trim() };
}

export function parseCseqHeader(value: string): { num: number; method: string } | null {
  const match = /^\s*(\d+)\s+([A-Za-z]+)\s*$/.exec(String(value || ''));
  if (!match) return null;
  return { num: Number(match[1]), method: match[2].toUpperCase() };
}

/** 1xx keeps waiting, 2xx means the dialer accepted the transfer, anything else is a refusal. */
export function referOutcome(status: number): 'pending' | 'accepted' | 'failed' {
  if (status >= 100 && status < 200) return 'pending';
  if (status >= 200 && status < 300) return 'accepted';
  return 'failed';
}

/** Final status of a REFER, taken from the sipfrag body of a NOTIFY (Event: refer). */
export function parseSipfragStatus(body: string): { status: number; reason: string } | null {
  const line = String(body || '').split(/\r?\n/).find((l) => /^SIP\/2\.0\s+\d{3}/i.test(l.trim()));
  return line ? parseSipResponseLine(line) : null;
}

interface PendingRefer {
  settle: (result: ReferResult) => void;
  /** True once the dialer answered 2xx; the transfer outcome then comes in a NOTIFY. */
  accepted: boolean;
  /** Called when the 2xx arrives, to start the wait for the final NOTIFY. */
  armNotifyWait: () => void;
}

/**
 * Matches REFER responses and NOTIFYs to the waiting transfer. One tracker per SIP socket.
 * A 2xx to REFER only means "request accepted"; the transfer has succeeded only when a
 * NOTIFY reports a final 2xx (or the dialer releases our leg after accepting).
 */
export class ReferTracker {
  private readonly pending = new Map<string, PendingRefer>();

  private key(callId: string, cseq: number): string {
    return `${callId}|${cseq}`;
  }

  wait(callId: string, cseq: number, send: () => void, timeoutMs = 5000, retryMs = 1000, notifyTimeoutMs = 8000): Promise<ReferResult> {
    const key = this.key(callId, cseq);
    return new Promise<ReferResult>((resolve) => {
      let retryTimer: NodeJS.Timeout | null = null;
      let timeoutTimer: NodeJS.Timeout | null = null;
      const settle = (result: ReferResult) => {
        if (retryTimer) clearTimeout(retryTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        this.pending.delete(key);
        resolve(result);
      };
      const entry: PendingRefer = {
        settle,
        accepted: false,
        armNotifyWait: () => {
          if (retryTimer) clearTimeout(retryTimer);
          if (timeoutTimer) clearTimeout(timeoutTimer);
          timeoutTimer = setTimeout(
            () => settle({ ok: false, message: 'REFER accepted but the dialer never reported the transfer result' }),
            notifyTimeoutMs
          );
        },
      };
      this.pending.set(key, entry);
      try {
        send();
      } catch (err: any) {
        settle({ ok: false, message: `REFER could not be sent: ${err?.message || 'unknown error'}` });
        return;
      }
      retryTimer = setTimeout(() => {
        if (!this.pending.has(key) || entry.accepted) return;
        try { send(); } catch {}
      }, retryMs);
      timeoutTimer = setTimeout(() => settle({ ok: false, message: 'REFER timed out: no answer from the dialer' }), timeoutMs);
    });
  }

  /** Feed every SIP response from a trusted peer; returns true when it belonged to a waiting REFER. */
  handleResponse(callId: string, cseqHeader: string, startLine: string): boolean {
    const cseq = parseCseqHeader(cseqHeader);
    const status = parseSipResponseLine(startLine);
    if (!cseq || !status || cseq.method !== 'REFER') return false;
    const entry = this.pending.get(this.key(callId, cseq.num));
    if (!entry) return false;
    const outcome = referOutcome(status.status);
    if (outcome === 'pending') return true;
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
  handleNotify(callId: string, body: string): boolean {
    const frag = parseSipfragStatus(body);
    if (!frag) return false;
    for (const [key, entry] of Array.from(this.pending.entries())) {
      if (!key.startsWith(`${callId}|`) || !entry.accepted) continue;
      const outcome = referOutcome(frag.status);
      if (outcome === 'pending') return true;
      entry.settle({ ok: outcome === 'accepted', message: `transfer ${frag.status} ${frag.reason}`.trim() });
      return true;
    }
    return false;
  }

  /**
   * Called when the call ends. If the dialer had accepted the REFER, it released our leg
   * to complete the transfer, which counts as success; otherwise the wait fails.
   */
  cancel(callId: string, reason = 'call ended before the dialer answered the REFER'): void {
    for (const [key, entry] of Array.from(this.pending.entries())) {
      if (!key.startsWith(`${callId}|`)) continue;
      if (entry.accepted) entry.settle({ ok: true, message: 'dialer released the call after accepting the REFER' });
      else entry.settle({ ok: false, message: reason });
    }
  }
}
