import crypto from 'crypto';
import dgram from 'dgram';
import dns from 'dns/promises';
import { ViciConfig } from './types';
import { getSecret } from './env-store';

type RegistrationStatus = 'stopped' | 'registering' | 'registered' | 'failed';

export interface SipRegistrationSnapshot {
  status: RegistrationStatus;
  registrar: string;
  expiresAt: string | null;
  lastError: string | null;
}

function md5(value: string): string {
  return crypto.createHash('md5').update(value).digest('hex');
}

function parseHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/).slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

function challengeParams(raw: string): Record<string, string> {
  const value = raw.replace(/^Digest\s+/i, '');
  const out: Record<string, string> = {};
  const re = /([a-z]+)=(?:"((?:\\.|[^"])*)"|([^,\s]+))/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value))) out[match[1].toLowerCase()] = (match[2] ?? match[3] ?? '').replace(/\\(.)/g, '$1');
  return out;
}

/**
 * Minimal RFC 3261 UDP registrar client. The media/SIP listener remains the
 * existing bridge; registration only advertises its reachable Contact URI.
 * Digest MD5/qop=auth is supported. TLS and AKA/SHA-256 auth are intentionally
 * rejected rather than silently downgraded.
 */
export class SipRegistrationClient {
  private socket: dgram.Socket | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private timeoutTimer: NodeJS.Timeout | null = null;
  private callId = crypto.randomUUID();
  private fromTag = crypto.randomBytes(8).toString('hex');
  private cseq = 1;
  private nonceCount = 0;
  private nonce = '';
  private realm = '';
  private opaque = '';
  private status: RegistrationStatus = 'stopped';
  private expiresAt: string | null = null;
  private lastError: string | null = null;
  private stopped = false;
  private registrarAddresses = new Set<string>();

  constructor(private readonly cfg: ViciConfig) {}

  snapshot(): SipRegistrationSnapshot {
    return {
      status: this.status,
      registrar: this.cfg.sipRegistrarHost ? `${this.cfg.sipRegistrarHost}:${this.cfg.sipRegistrarPort}` : '',
      expiresAt: this.expiresAt,
      lastError: this.lastError,
    };
  }

  async start(): Promise<void> {
    if (!['registration', 'hybrid'].includes(this.cfg.sipConnectionMode)) return;
    if (!this.cfg.sipRegistrarHost || !this.cfg.sipUsername || !this.cfg.bridgeHost) {
      this.status = 'failed';
      this.lastError = 'SIP registration requires registrar host, SIP username, and a public bridge host.';
      return;
    }
    if (this.cfg.sipTransportProtocol !== 'udp') {
      this.status = 'failed';
      this.lastError = 'Only UDP SIP registration is currently supported; TLS/TCP is not enabled.';
      return;
    }
    if (!getSecret('VICI_SIP_PASSWORD')) {
      this.status = 'failed';
      this.lastError = 'VICI_SIP_PASSWORD is not configured in server secrets.';
      return;
    }
    this.stopped = false;
    try {
      const resolved = await dns.lookup(this.cfg.sipRegistrarHost, { all: true, family: 4 });
      this.registrarAddresses = new Set(resolved.map((entry) => entry.address));
    } catch (err: any) {
      this.status = 'failed';
      this.lastError = `Could not resolve SIP registrar: ${err?.message || 'DNS lookup failed'}`;
      return;
    }
    this.socket = dgram.createSocket('udp4');
    this.socket.on('message', (message, peer) => {
      if (!this.registrarAddresses.has(peer.address) || peer.port !== this.cfg.sipRegistrarPort) return;
      void this.handleResponse(message.toString('utf8'));
    });
    this.socket.on('error', (err) => {
      this.status = 'failed';
      this.lastError = err.message;
    });
    await new Promise<void>((resolve, reject) => {
      this.socket!.once('error', reject);
      this.socket!.bind(0, '0.0.0.0', () => {
        this.socket!.removeListener('error', reject);
        resolve();
      });
    });
    this.status = 'registering';
    this.sendRegister();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.refreshTimer = null;
    this.timeoutTimer = null;
    if (this.socket) {
      try { this.sendRegister(0); } catch {}
      const socket = this.socket;
      this.socket = null;
      await new Promise<void>((resolve) => socket.close(() => resolve()));
    }
    this.status = 'stopped';
  }

  private authHeader(method: string, uri: string): string {
    const username = this.cfg.sipAuthUsername || this.cfg.sipUsername;
    const password = getSecret('VICI_SIP_PASSWORD');
    const ha1 = md5(`${username}:${this.realm}:${password}`);
    const ha2 = md5(`${method}:${uri}`);
    const qop = 'auth';
    const nc = (++this.nonceCount).toString(16).padStart(8, '0');
    const cnonce = crypto.randomBytes(12).toString('hex');
    const response = md5(`${ha1}:${this.nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
    return `Digest username="${username}", realm="${this.realm}", nonce="${this.nonce}", uri="${uri}", response="${response}", algorithm=MD5, qop=auth, nc=${nc}, cnonce="${cnonce}"${this.opaque ? `, opaque="${this.opaque}"` : ''}`;
  }

  private sendRegister(expires = 3600): void {
    if (!this.socket || this.stopped) return;
    const host = this.cfg.sipRegistrarHost;
    const port = this.cfg.sipRegistrarPort;
    const domain = this.cfg.sipDomain || host;
    const uri = `sip:${domain}`;
    const user = this.cfg.sipUsername;
    const branch = `z9hG4bK${crypto.randomBytes(8).toString('hex')}`;
    const contact = `<sip:${user}@${this.cfg.bridgeHost}:${this.cfg.sipPort};transport=udp>`;
    const auth = this.nonce ? `Authorization: ${this.authHeader('REGISTER', uri)}\r\n` : '';
    const request = [
      `REGISTER ${uri} SIP/2.0`,
      `Via: SIP/2.0/UDP ${this.cfg.bridgeHost}:${this.cfg.sipPort};branch=${branch};rport`,
      'Max-Forwards: 70',
      `From: <sip:${user}@${domain}>;tag=${this.fromTag}`,
      `To: <sip:${user}@${domain}>`,
      `Call-ID: ${this.callId}`,
      `CSeq: ${this.cseq++} REGISTER`,
      `Contact: ${contact}`,
      `Expires: ${expires}`,
      'User-Agent: MMA-Voice-Agent-Console',
      auth.trimEnd(),
      'Content-Length: 0',
      '',
      '',
    ].filter((line) => line !== '').join('\r\n');
    this.socket.send(Buffer.from(request), port, host, (err) => {
      if (err) {
        this.status = 'failed';
        this.lastError = err.message;
      }
    });
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.timeoutTimer = setTimeout(() => {
      if (!this.stopped && this.status !== 'registered') {
        this.status = 'failed';
        this.lastError = 'No SIP REGISTER response received within 8 seconds.';
      }
    }, 8000);
    this.timeoutTimer.unref();
  }

  private async handleResponse(raw: string): Promise<void> {
    if (this.stopped) return;
    const statusLine = raw.split(/\r?\n/, 1)[0] || '';
    const status = Number(/^SIP\/2\.0\s+(\d+)/.exec(statusLine)?.[1] || 0);
    const headers = parseHeaders(raw);
    if (status === 401 || status === 407) {
      const challenge = challengeParams(headers[status === 407 ? 'proxy-authenticate' : 'www-authenticate'] || '');
      if (!challenge.realm || !challenge.nonce || (challenge.algorithm && challenge.algorithm.toUpperCase() !== 'MD5')) {
        this.status = 'failed';
        this.lastError = 'Registrar returned an unsupported SIP digest challenge.';
        return;
      }
      this.realm = challenge.realm;
      this.nonce = challenge.nonce;
      this.opaque = challenge.opaque || '';
      this.nonceCount = 0;
      this.sendRegister();
      return;
    }
    if (status >= 200 && status < 300) {
      if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
      const expiresHeader = Number(headers.expires || 3600);
      const expires = Number.isFinite(expiresHeader) ? Math.max(60, Math.min(expiresHeader, 86400)) : 3600;
      this.status = 'registered';
      this.lastError = null;
      this.expiresAt = new Date(Date.now() + expires * 1000).toISOString();
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => this.sendRegister(), Math.max(30, Math.floor(expires * 0.8)) * 1000);
      this.refreshTimer.unref();
      return;
    }
    if (status >= 300) {
      this.status = 'failed';
      this.lastError = `Registrar rejected REGISTER: ${statusLine}`;
    }
  }
}
