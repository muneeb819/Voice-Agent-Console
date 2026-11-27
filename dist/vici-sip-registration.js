"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SipRegistrationClient = void 0;
const crypto_1 = __importDefault(require("crypto"));
const dgram_1 = __importDefault(require("dgram"));
const promises_1 = __importDefault(require("dns/promises"));
const env_store_1 = require("./env-store");
function md5(value) {
    return crypto_1.default.createHash('md5').update(value).digest('hex');
}
function isLoopbackOrUnspecifiedHost(host) {
    const value = String(host || '').trim().toLowerCase();
    return !value || value === 'localhost' || value === '0.0.0.0' || value === '::' ||
        /^127\./.test(value) || value === '::1' || value === '[::1]';
}
function hasUnsafeHeaderChars(value) {
    // Reject every character that can terminate a header or change SIP URI
    // parameters. normalizeState uses a narrower allowlist; this is the
    // defense-in-depth check for callers that construct the client directly.
    return /[\r\n\0"<>;,\s@]/.test(String(value || ''));
}
// Digest challenge values are reflected back into an Authorization header.
// Strip CR/LF/NUL and escape quotes/backslashes so a registrar cannot inject a
// second header or break out of a quoted parameter.
function quoteDigestValue(value) {
    return String(value || '').replace(/[\r\n\0]/g, '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
function parseHeaders(raw) {
    const out = {};
    for (const line of raw.split(/\r?\n/).slice(1)) {
        const i = line.indexOf(':');
        if (i > 0)
            out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    return out;
}
function challengeParams(raw) {
    const value = raw.replace(/^Digest\s+/i, '');
    const out = {};
    const re = /([a-z]+)=(?:"((?:\\.|[^"])*)"|([^,\s]+))/gi;
    let match;
    while ((match = re.exec(value)))
        out[match[1].toLowerCase()] = (match[2] ?? match[3] ?? '').replace(/\\(.)/g, '$1');
    return out;
}
/**
 * Minimal RFC 3261 UDP registrar client. The media/SIP listener remains the
 * existing bridge; registration only advertises its reachable Contact URI.
 * Digest MD5/qop=auth is supported. TLS and AKA/SHA-256 auth are intentionally
 * rejected rather than silently downgraded.
 */
class SipRegistrationClient {
    cfg;
    socket = null;
    refreshTimer = null;
    timeoutTimer = null;
    callId = crypto_1.default.randomUUID();
    fromTag = crypto_1.default.randomBytes(8).toString('hex');
    cseq = 1;
    nonceCount = 0;
    authAttempts = 0;
    nonce = '';
    realm = '';
    opaque = '';
    qop = '';
    status = 'stopped';
    expiresAt = null;
    lastError = null;
    stopped = false;
    registrarAddresses = new Set();
    proxyAuth = false;
    constructor(cfg) {
        this.cfg = cfg;
    }
    snapshot() {
        return {
            status: this.status,
            registrar: this.cfg.sipRegistrarHost ? `${this.cfg.sipRegistrarHost}:${this.cfg.sipRegistrarPort}` : '',
            expiresAt: this.expiresAt,
            lastError: this.lastError,
        };
    }
    fail(message) {
        this.status = 'failed';
        this.lastError = message;
        this.expiresAt = null;
    }
    async start() {
        if (!['registration', 'hybrid'].includes(this.cfg.sipConnectionMode))
            return;
        if (!this.cfg.sipRegistrarHost || !this.cfg.sipUsername || !this.cfg.bridgeHost) {
            this.fail('SIP registration requires registrar host, SIP username, and a public bridge host.');
            return;
        }
        if (this.cfg.sipTransportProtocol !== 'udp') {
            this.fail('Only UDP SIP registration is currently supported; TLS/TCP is not enabled.');
            return;
        }
        // These values are interpolated into raw SIP headers. normalizeState strips
        // them, but validate again so a direct constructor call cannot inject CRLF.
        if ([this.cfg.sipRegistrarHost, this.cfg.sipDomain, this.cfg.sipUsername, this.cfg.sipAuthUsername, this.cfg.bridgeHost]
            .some(hasUnsafeHeaderChars)) {
            this.fail('SIP configuration contains unsafe header characters.');
            return;
        }
        if (isLoopbackOrUnspecifiedHost(this.cfg.bridgeHost)) {
            this.fail('SIP registration needs a public/reachable Bridge Host; loopback and 0.0.0.0 are not advertisable to a registrar.');
            return;
        }
        if (!(0, env_store_1.getSecret)('VICI_SIP_PASSWORD')) {
            this.fail('VICI_SIP_PASSWORD is not configured in server secrets.');
            return;
        }
        this.stopped = false;
        this.authAttempts = 0;
        try {
            const resolved = await promises_1.default.lookup(this.cfg.sipRegistrarHost, { all: true, family: 4 });
            this.registrarAddresses = new Set(resolved.map((entry) => entry.address));
        }
        catch (err) {
            this.fail(`Could not resolve SIP registrar: ${err?.message || 'DNS lookup failed'}`);
            return;
        }
        this.socket = dgram_1.default.createSocket('udp4');
        this.socket.on('message', (message, peer) => {
            if (!this.registrarAddresses.has(peer.address) || peer.port !== this.cfg.sipRegistrarPort)
                return;
            void this.handleResponse(message.toString('utf8'));
        });
        this.socket.on('error', (err) => {
            this.fail(err.message);
        });
        await new Promise((resolve, reject) => {
            this.socket.once('error', reject);
            this.socket.bind(0, '0.0.0.0', () => {
                this.socket.removeListener('error', reject);
                resolve();
            });
        });
        this.status = 'registering';
        this.sendRegister();
    }
    async stop() {
        if (this.socket && !this.stopped && this.status === 'registered') {
            this.sendRegister(0);
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
        this.stopped = true;
        if (this.refreshTimer)
            clearTimeout(this.refreshTimer);
        if (this.timeoutTimer)
            clearTimeout(this.timeoutTimer);
        this.refreshTimer = null;
        this.timeoutTimer = null;
        if (this.socket) {
            const socket = this.socket;
            this.socket = null;
            await new Promise((resolve) => {
                try {
                    socket.close(() => resolve());
                }
                catch {
                    resolve();
                }
            });
        }
        this.status = 'stopped';
        this.expiresAt = null;
    }
    authHeader(method, uri) {
        const username = this.cfg.sipAuthUsername || this.cfg.sipUsername;
        const password = (0, env_store_1.getSecret)('VICI_SIP_PASSWORD');
        const ha1 = md5(`${username}:${this.realm}:${password}`);
        const ha2 = md5(`${method}:${uri}`);
        const q = quoteDigestValue;
        if (this.qop === 'auth') {
            const nc = (++this.nonceCount).toString(16).padStart(8, '0');
            const cnonce = crypto_1.default.randomBytes(12).toString('hex');
            const response = md5(`${ha1}:${this.nonce}:${nc}:${cnonce}:auth:${ha2}`);
            return `Digest username="${q(username)}", realm="${q(this.realm)}", nonce="${q(this.nonce)}", uri="${q(uri)}", response="${response}", algorithm=MD5, qop=auth, nc=${nc}, cnonce="${cnonce}"${this.opaque ? `, opaque="${q(this.opaque)}"` : ''}`;
        }
        const response = md5(`${ha1}:${this.nonce}:${ha2}`);
        return `Digest username="${q(username)}", realm="${q(this.realm)}", nonce="${q(this.nonce)}", uri="${q(uri)}", response="${response}", algorithm=MD5${this.opaque ? `, opaque="${q(this.opaque)}"` : ''}`;
    }
    sendRegister(expires = 3600) {
        if (!this.socket || this.stopped)
            return;
        const host = this.cfg.sipRegistrarHost;
        const port = this.cfg.sipRegistrarPort;
        const domain = this.cfg.sipDomain || host;
        const uri = `sip:${domain}`;
        const user = this.cfg.sipUsername;
        const branch = `z9hG4bK${crypto_1.default.randomBytes(8).toString('hex')}`;
        const localPort = this.socket.address().port;
        const contact = `<sip:${user}@${this.cfg.bridgeHost}:${this.cfg.sipPort};transport=udp>`;
        const request = [
            `REGISTER ${uri} SIP/2.0`,
            `Via: SIP/2.0/UDP ${this.cfg.bridgeHost}:${localPort};branch=${branch};rport`,
            'Max-Forwards: 70',
            `From: <sip:${user}@${domain}>;tag=${this.fromTag}`,
            `To: <sip:${user}@${domain}>`,
            `Call-ID: ${this.callId}`,
            `CSeq: ${this.cseq++} REGISTER`,
            `Contact: ${contact}`,
            `Expires: ${expires}`,
            'User-Agent: MMA-Voice-Agent-Console',
            ...(this.nonce ? [`${this.proxyAuth ? 'Proxy-Authorization' : 'Authorization'}: ${this.authHeader('REGISTER', uri)}`] : []),
            'Content-Length: 0',
        ].join('\r\n') + '\r\n\r\n';
        this.socket.send(Buffer.from(request), port, host, (err) => {
            if (err) {
                this.fail(err.message);
            }
        });
        if (this.timeoutTimer)
            clearTimeout(this.timeoutTimer);
        this.timeoutTimer = setTimeout(() => {
            if (!this.stopped && this.status !== 'registered') {
                this.fail('No SIP REGISTER response received within 8 seconds.');
            }
        }, 8000);
        this.timeoutTimer.unref();
    }
    async handleResponse(raw) {
        if (this.stopped)
            return;
        const statusLine = (raw.split(/\r?\n/, 1)[0] || '').slice(0, 180);
        const status = Number(/^SIP\/2\.0\s+(\d+)/.exec(statusLine)?.[1] || 0);
        const headers = parseHeaders(raw);
        if (status === 401 || status === 407) {
            if (++this.authAttempts > 2) {
                this.fail('Registrar rejected the SIP credentials repeatedly (401/407).');
                return;
            }
            const rawAuth = headers[status === 407 ? 'proxy-authenticate' : 'www-authenticate'] || '';
            if (!/^Digest\s+/i.test(rawAuth.trim())) {
                this.fail('Registrar returned an unsupported SIP digest challenge.');
                return;
            }
            const challenge = challengeParams(rawAuth);
            const qops = String(challenge.qop || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
            const hasValidQop = qops.length === 0 || qops.includes('auth');
            if (!challenge.realm || !challenge.nonce || !hasValidQop || (challenge.algorithm && challenge.algorithm.toUpperCase() !== 'MD5')) {
                this.fail('Registrar returned an unsupported SIP digest challenge.');
                return;
            }
            this.proxyAuth = status === 407;
            this.realm = String(challenge.realm).slice(0, 200);
            this.nonce = String(challenge.nonce).slice(0, 512);
            this.opaque = String(challenge.opaque || '').slice(0, 512);
            this.qop = qops.includes('auth') ? 'auth' : '';
            this.nonceCount = 0;
            this.sendRegister();
            return;
        }
        if (status >= 200 && status < 300) {
            if (this.timeoutTimer)
                clearTimeout(this.timeoutTimer);
            this.timeoutTimer = null;
            // RFC 3261 §10.2.4: Contact header `;expires=N` takes precedence over Expires header.
            const contactExpMatch = /;\s*expires\s*=\s*(\d+)/i.exec(headers.contact || '');
            const rawExpires = contactExpMatch
                ? Number(contactExpMatch[1])
                : headers.expires !== undefined
                    ? Number(headers.expires)
                    : 3600;
            if (!Number.isFinite(rawExpires) || rawExpires <= 0) {
                this.fail('Registrar returned Expires: 0 (binding not registered).');
                return;
            }
            const expires = Math.max(60, Math.min(rawExpires, 86400));
            this.status = 'registered';
            this.lastError = null;
            this.authAttempts = 0;
            this.expiresAt = new Date(Date.now() + expires * 1000).toISOString();
            if (this.refreshTimer)
                clearTimeout(this.refreshTimer);
            this.refreshTimer = setTimeout(() => {
                this.status = 'registering';
                this.expiresAt = null;
                this.sendRegister();
            }, Math.max(30, Math.floor(expires * 0.8)) * 1000);
            this.refreshTimer.unref();
            return;
        }
        if (status >= 300) {
            this.fail(`Registrar rejected REGISTER: ${statusLine}`);
        }
    }
}
exports.SipRegistrationClient = SipRegistrationClient;
