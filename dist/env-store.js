"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MANAGED_SECRET_KEYS = void 0;
exports.sanitizeSecretValue = sanitizeSecretValue;
exports.loadEnv = loadEnv;
exports.getSecret = getSecret;
exports.maskSecret = maskSecret;
exports.getSecretsStatus = getSecretsStatus;
exports.updateSecrets = updateSecrets;
exports.verifyDeepgramConnection = verifyDeepgramConnection;
const dns_1 = __importDefault(require("dns"));
const fs_1 = __importDefault(require("fs"));
const net_1 = __importDefault(require("net"));
const path_1 = __importDefault(require("path"));
const dotenv_1 = __importDefault(require("dotenv"));
const ws_1 = __importDefault(require("ws"));
dns_1.default.setDefaultResultOrder('ipv4first');
if (typeof net_1.default.setDefaultAutoSelectFamily === 'function') {
    net_1.default.setDefaultAutoSelectFamily(false);
}
const ENV_PATH = path_1.default.resolve(__dirname, '..', '.env');
exports.MANAGED_SECRET_KEYS = [
    'DEEPGRAM_API_KEY',
    'SPEECH_SERVICE_URL',
    'SPEECH_SERVICE_API_KEY',
    'ELEVENLABS_API_KEY',
    'CARTESIA_API_KEY',
    'OPENAI_API_KEY',
    'GROQ_API_KEY',
    'VICI_API_PASS',
    'AMI_SECRET',
    'CUSTOM_WEBHOOK_SECRET',
    'ADMIN_PASSWORD',
    'BRIDGE_ALLOWED_IPS',
];
function sanitizeSecretValue(raw) {
    let clean = String(raw ?? '').trim();
    // Strip surrounding single/double quotes if pasted from .env or docs
    if ((clean.startsWith('"') && clean.endsWith('"')) ||
        (clean.startsWith("'") && clean.endsWith("'"))) {
        clean = clean.slice(1, -1).trim();
    }
    // Strip accidental "Token " or "Bearer " prefix if user copied header value
    clean = clean.replace(/^(Token|Bearer)\s+/i, '').trim();
    return clean;
}
function loadEnv() {
    if (fs_1.default.existsSync(ENV_PATH)) {
        dotenv_1.default.config({ path: ENV_PATH });
    }
}
function getSecret(key) {
    return sanitizeSecretValue(process.env[key] || '');
}
function maskSecret(val) {
    const clean = sanitizeSecretValue(val || '');
    if (!clean)
        return '';
    if (clean.length <= 8)
        return '••••••••';
    return `${clean.slice(0, 4)}••••${clean.slice(-4)}`;
}
function getSecretsStatus() {
    loadEnv();
    const out = {};
    for (const key of exports.MANAGED_SECRET_KEYS) {
        const val = getSecret(key);
        out[key] = {
            configured: val.length > 0,
            masked: maskSecret(val),
        };
    }
    return out;
}
function updateSecrets(updates) {
    let content = fs_1.default.existsSync(ENV_PATH) ? fs_1.default.readFileSync(ENV_PATH, 'utf8') : '';
    const lines = content.split(/\r?\n/);
    for (const key of exports.MANAGED_SECRET_KEYS) {
        if (updates[key] === undefined)
            continue;
        const newVal = sanitizeSecretValue(String(updates[key] ?? ''));
        process.env[key] = newVal;
        const regex = new RegExp(`^\\s*${key}\\s*=`);
        const idx = lines.findIndex((line) => regex.test(line));
        const formatted = `${key}=${newVal}`;
        if (idx >= 0) {
            lines[idx] = formatted;
        }
        else {
            lines.push(formatted);
        }
    }
    fs_1.default.writeFileSync(ENV_PATH, lines.join('\n').replace(/\n+$/, '\n'), 'utf8');
}
/**
 * Verifies DEEPGRAM_API_KEY against:
 * 1) Authenticated REST `/v1/projects` (catches 401 invalid keys immediately; accepts 403 scoped keys)
 * 2) Live TTS `/v2/speak` synthesis
 * 3) Live Voice Agent WebSocket `wss://agent.deepgram.com/v1/agent/converse` (`Welcome` -> `Settings` -> `SettingsApplied`)
 */
async function verifyDeepgramConnection(explicitKey) {
    const apiKey = sanitizeSecretValue(explicitKey ?? getSecret('DEEPGRAM_API_KEY'));
    if (!apiKey) {
        const skipped = { ok: false, error: 'Skipped (no key)' };
        return {
            ok: false,
            restAuth: { ok: false, error: 'DEEPGRAM_API_KEY is empty' },
            ttsSpeak: skipped,
            voiceAgentWs: skipped,
            agentWebSocket: skipped,
        };
    }
    const result = {
        ok: false,
        restAuth: { ok: false },
        ttsSpeak: { ok: false },
        voiceAgentWs: { ok: false },
        agentWebSocket: { ok: false },
    };
    // 1. Authenticated REST check (/v1/projects)
    try {
        const res = await fetch('https://api.deepgram.com/v1/projects', {
            headers: { Authorization: `Token ${apiKey}`, Accept: 'application/json' },
            signal: AbortSignal.timeout(10000),
        });
        if (res.status === 401) {
            const txt = await res.text();
            result.restAuth = {
                ok: false,
                status: 401,
                error: `HTTP 401: ${txt.slice(0, 180)}`,
            };
            return result;
        }
        else if (res.status === 403) {
            // Valid key with restricted scopes (e.g. Usage/Voice Agent without projects:read)
            result.restAuth = { ok: true, status: 200, projectName: 'Scoped Key (Valid Auth)' };
        }
        else if (!res.ok) {
            const txt = await res.text();
            result.restAuth = {
                ok: false,
                status: res.status,
                error: `HTTP ${res.status}: ${txt.slice(0, 180)}`,
            };
            return result;
        }
        else {
            const data = await res.json();
            const firstProj = Array.isArray(data?.projects) ? data.projects[0]?.name : undefined;
            result.restAuth = { ok: true, status: 200, projectName: firstProj || 'Verified' };
        }
    }
    catch (err) {
        result.restAuth = { ok: false, error: err?.message || 'Network error reaching api.deepgram.com' };
        return result;
    }
    // 2. TTS synthesis check (/v2/speak)
    try {
        const ttsRes = await fetch('https://api.deepgram.com/v2/speak?model=flux-haley-en&encoding=mp3', {
            method: 'POST',
            headers: {
                Authorization: `Token ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ text: 'Connection verified.' }),
            signal: AbortSignal.timeout(10000),
        });
        if (!ttsRes.ok) {
            const txt = await ttsRes.text();
            result.ttsSpeak = { ok: false, status: ttsRes.status, error: `HTTP ${ttsRes.status}: ${txt.slice(0, 180)}` };
        }
        else {
            const buf = await ttsRes.arrayBuffer();
            result.ttsSpeak = { ok: true, status: 200, bytes: buf.byteLength };
        }
    }
    catch (err) {
        result.ttsSpeak = { ok: false, error: err?.message || 'TTS request failed' };
    }
    // 3. Voice Agent WebSocket handshake check
    const agentUrl = (process.env.DEEPGRAM_AGENT_URL || '').trim() || 'wss://agent.deepgram.com/v1/agent/converse';
    const wsStartedAt = Date.now();
    const wsCheck = await new Promise((resolve) => {
        let settled = false;
        let requestId = '';
        const done = (val) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            try {
                ws.close(1000, 'diagnostic_done');
            }
            catch { }
            resolve(val);
        };
        const ws = new ws_1.default(agentUrl, {
            headers: { Authorization: `Token ${apiKey}` },
            family: 4,
        });
        const timer = setTimeout(() => {
            done({ ok: false, error: 'Timed out waiting for Welcome / SettingsApplied from agent.deepgram.com' });
        }, 9000);
        ws.on('unexpected-response', (_req, res) => {
            let body = '';
            res.on('data', (chunk) => {
                body += chunk.toString();
            });
            res.on('end', () => {
                const dgErr = res.headers['dg-error'] ? ` (${res.headers['dg-error']})` : '';
                done({
                    ok: false,
                    error: `HTTP ${res.statusCode}${dgErr}: ${body.slice(0, 200) || 'WebSocket upgrade rejected'}`,
                });
            });
        });
        ws.on('message', (raw, isBinary) => {
            if (isBinary)
                return;
            try {
                const msg = JSON.parse(raw.toString());
                if (msg.type === 'Welcome') {
                    requestId = msg.request_id || '';
                    ws.send(JSON.stringify({
                        type: 'Settings',
                        audio: {
                            input: { encoding: 'linear16', sample_rate: 16000 },
                            output: { encoding: 'linear16', sample_rate: 24000, container: 'none' },
                        },
                        agent: {
                            listen: { provider: { type: 'deepgram', model: 'nova-3' } },
                            think: {
                                provider: { type: 'open_ai', model: 'gpt-4o-mini', temperature: 0.7 },
                                prompt: 'Diagnostic ping.',
                            },
                            speak: { provider: { type: 'deepgram', version: 'v2', model: 'flux-kit-en' } },
                        },
                    }));
                }
                else if (msg.type === 'SettingsApplied') {
                    done({ ok: true, latencyMs: Math.max(1, Date.now() - wsStartedAt), requestId });
                }
                else if (msg.type === 'Error') {
                    done({ ok: false, error: `${msg.code || 'Error'}: ${msg.description || JSON.stringify(msg)}` });
                }
            }
            catch { }
        });
        ws.on('error', (err) => {
            done({ ok: false, error: err.message });
        });
        ws.on('close', (code, reason) => {
            if (!settled) {
                done({ ok: false, error: `WebSocket closed early (${code} ${reason.toString()})` });
            }
        });
    });
    result.voiceAgentWs = wsCheck;
    result.agentWebSocket = wsCheck;
    result.ok = result.restAuth.ok && result.ttsSpeak.ok && result.voiceAgentWs.ok;
    return result;
}
