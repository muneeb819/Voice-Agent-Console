"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AsteriskAmiClient = void 0;
const net_1 = __importDefault(require("net"));
const env_store_1 = require("./env-store");
/**
 * Lightweight Asterisk Manager Interface (AMI) TCP client (:5038)
 * Used for connectivity diagnostics, non-Remote-Agent channel Redirect transfers,
 * and channel Hangup fallback on co-located ViciBox deployments.
 */
class AsteriskAmiClient {
    host;
    port;
    username;
    secretOverride;
    constructor(cfg, secretOverride) {
        this.host = cfg.amiHost || '127.0.0.1';
        this.port = Number(cfg.amiPort || 5038);
        this.username = cfg.amiUser || 'cron';
        this.secretOverride = secretOverride;
    }
    get secret() {
        return this.secretOverride !== undefined ? this.secretOverride : (0, env_store_1.getSecret)('AMI_SECRET');
    }
    async executeAction(actionName, fields = {}, timeoutMs = 3500) {
        if (!this.secret) {
            return {
                ok: false,
                response: 'MissingSecret',
                message: 'AMI_SECRET is not configured in server .env',
                raw: '',
            };
        }
        return new Promise((resolve) => {
            let settled = false;
            let buffer = '';
            let loggedIn = false;
            let bannerSeen = false;
            const finish = (res) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                try {
                    socket.end('Action: Logoff\r\n\r\n');
                    socket.destroy();
                }
                catch { }
                resolve(res);
            };
            const socket = net_1.default.createConnection({ host: this.host, port: this.port });
            const timer = setTimeout(() => {
                finish({
                    ok: false,
                    response: 'Timeout',
                    message: `Timed out connecting/authenticating to Asterisk AMI at ${this.host}:${this.port}`,
                    raw: buffer.slice(0, 300),
                });
            }, timeoutMs);
            const sendFrame = (lines) => {
                socket.write(lines.join('\r\n') + '\r\n\r\n');
            };
            socket.on('data', (chunk) => {
                buffer += chunk.toString('utf8');
                if (!bannerSeen && buffer.includes('\r\n')) {
                    bannerSeen = true;
                    // Strip initial "Asterisk Call Manager/x.y.z\r\n" greeting line
                    const nlIdx = buffer.indexOf('\r\n');
                    buffer = buffer.slice(nlIdx + 2);
                    sendFrame([
                        'Action: Login',
                        `Username: ${this.username}`,
                        `Secret: ${this.secret}`,
                        'Events: off',
                    ]);
                }
                let sepIdx;
                while ((sepIdx = buffer.indexOf('\r\n\r\n')) !== -1) {
                    const block = buffer.slice(0, sepIdx);
                    buffer = buffer.slice(sepIdx + 4);
                    const map = {};
                    for (const line of block.split('\r\n')) {
                        const cIdx = line.indexOf(':');
                        if (cIdx > 0) {
                            const k = line.slice(0, cIdx).trim().toLowerCase();
                            const v = line.slice(cIdx + 1).trim();
                            map[k] = v;
                        }
                    }
                    if (!loggedIn && map.response) {
                        if (map.response.toLowerCase() === 'success') {
                            loggedIn = true;
                            if (actionName.toLowerCase() === 'login') {
                                finish({
                                    ok: true,
                                    response: map.response,
                                    message: map.message || 'Authentication accepted',
                                    raw: block,
                                });
                                return;
                            }
                            const actionLines = [`Action: ${actionName}`];
                            for (const [k, v] of Object.entries(fields)) {
                                actionLines.push(`${k}: ${v}`);
                            }
                            sendFrame(actionLines);
                        }
                        else {
                            finish({
                                ok: false,
                                response: map.response,
                                message: map.message || 'AMI Login failed',
                                raw: block,
                            });
                            return;
                        }
                    }
                    else if (loggedIn && map.response) {
                        finish({
                            ok: map.response.toLowerCase() === 'success',
                            response: map.response,
                            message: map.message || '',
                            raw: block,
                        });
                        return;
                    }
                }
            });
            socket.on('error', (err) => {
                finish({
                    ok: false,
                    response: 'SocketError',
                    message: `AMI TCP error (${this.host}:${this.port}): ${err.message}`,
                    raw: '',
                });
            });
            socket.on('close', () => {
                if (!settled) {
                    finish({
                        ok: false,
                        response: 'Closed',
                        message: 'AMI socket closed unexpectedly',
                        raw: buffer.slice(0, 300),
                    });
                }
            });
        });
    }
    async ping() {
        return this.executeAction('Ping');
    }
    async redirectChannel(opts) {
        return this.executeAction('Redirect', {
            Channel: opts.channel,
            Exten: opts.exten,
            Context: opts.context || 'default',
            Priority: opts.priority || 1,
        });
    }
    async hangupChannel(channel) {
        return this.executeAction('Hangup', { Channel: channel });
    }
}
exports.AsteriskAmiClient = AsteriskAmiClient;
