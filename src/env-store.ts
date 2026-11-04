import dns from 'dns';
import fs from 'fs';
import net from 'net';
import path from 'path';
import dotenv from 'dotenv';
import WebSocket from 'ws';

dns.setDefaultResultOrder('ipv4first');
if (typeof net.setDefaultAutoSelectFamily === 'function') {
  net.setDefaultAutoSelectFamily(false);
}

// Tests and isolated installations can point secret writes at a dedicated file.
const ENV_PATH = process.env.VAC_ENV_FILE
  ? path.resolve(process.env.VAC_ENV_FILE)
  : path.resolve(__dirname, '..', '.env');

export const MANAGED_SECRET_KEYS = [
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
] as const;

export type SecretKeyName = (typeof MANAGED_SECRET_KEYS)[number];

export function sanitizeSecretValue(raw: string): string {
  let clean = String(raw ?? '').trim();
  // Strip surrounding single/double quotes if pasted from .env or docs
  if (
    (clean.startsWith('"') && clean.endsWith('"')) ||
    (clean.startsWith("'") && clean.endsWith("'"))
  ) {
    clean = clean.slice(1, -1).trim();
  }
  // Strip accidental "Token " or "Bearer " prefix if user copied header value
  clean = clean.replace(/^(Token|Bearer)\s+/i, '').trim();
  return clean;
}

export function loadEnv(): void {
  if (fs.existsSync(ENV_PATH)) {
    dotenv.config({ path: ENV_PATH });
  }
}

export function getSecret(key: SecretKeyName): string {
  return sanitizeSecretValue(process.env[key] || '');
}

export function maskSecret(val: string): string {
  const clean = sanitizeSecretValue(val || '');
  if (!clean) return '';
  if (clean.length <= 8) return '••••••••';
  return `${clean.slice(0, 4)}••••${clean.slice(-4)}`;
}

export function getSecretsStatus(): Record<SecretKeyName, { configured: boolean; masked: string }> {
  loadEnv();
  const out = {} as Record<SecretKeyName, { configured: boolean; masked: string }>;
  for (const key of MANAGED_SECRET_KEYS) {
    const val = getSecret(key);
    out[key] = {
      configured: val.length > 0,
      masked: maskSecret(val),
    };
  }
  return out;
}

export function updateSecrets(updates: Partial<Record<SecretKeyName, string>>): void {
  const content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
  const lines = content.split(/\r?\n/);
  const normalized: Partial<Record<SecretKeyName, string>> = {};
  const formattedLines: Partial<Record<SecretKeyName, string>> = {};

  // Validate the whole update before changing either the file or process.env.
  for (const key of MANAGED_SECRET_KEYS) {
    if (updates[key] === undefined) continue;
    const raw = String(updates[key] ?? '');
    if (/[\r\n\0]/.test(raw)) throw new Error(`${key} must not contain newlines or NUL characters`);
    const value = sanitizeSecretValue(raw);
    normalized[key] = value;
    // Select a form that the actual dotenv parser round-trips exactly. Quotes,
    // backslashes and # interact in non-obvious ways; reject combinations that
    // cannot be represented instead of silently saving a different secret.
    const candidates = value ? ["'", '`', '"'].map((q) => `${key}=${q}${value}${q}`) : [`${key}=`];
    const formatted = candidates.find((line) => dotenv.parse(line)[key] === value);
    if (!formatted) throw new Error(`${key} contains characters that cannot be stored safely`);
    formattedLines[key] = formatted;
  }

  for (const key of MANAGED_SECRET_KEYS) {
    const formatted = formattedLines[key];
    if (formatted === undefined) continue;
    const regex = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
    const indexes = lines.map((line, index) => regex.test(line) ? index : -1).filter((index) => index >= 0);
    if (indexes.length) {
      lines[indexes[0]] = formatted;
      // A later duplicate would otherwise override the new value on restart.
      for (const index of indexes.slice(1).reverse()) lines.splice(index, 1);
    } else lines.push(formatted);
  }

  // Do not expose newly written credentials to other local users, and do not
  // leave a partially written .env if the process is interrupted.
  const tmpPath = `${ENV_PATH}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, lines.join('\n').replace(/\n+$/, '\n'), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(tmpPath, ENV_PATH);
    fs.chmodSync(ENV_PATH, 0o600);
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
  for (const key of MANAGED_SECRET_KEYS) {
    if (normalized[key] !== undefined) process.env[key] = normalized[key];
  }
}

export interface DeepgramDiagnosticResult {
  ok: boolean;
  restAuth: { ok: boolean; projectName?: string; status?: number; error?: string };
  ttsSpeak: { ok: boolean; bytes?: number; status?: number; error?: string };
  voiceAgentWs: { ok: boolean; latencyMs?: number; requestId?: string; error?: string };
  agentWebSocket: { ok: boolean; latencyMs?: number; requestId?: string; error?: string };
}

/**
 * Verifies DEEPGRAM_API_KEY against:
 * 1) Authenticated REST `/v1/projects` (catches 401 invalid keys immediately; accepts 403 scoped keys)
 * 2) Live TTS `/v2/speak` synthesis
 * 3) Live Voice Agent WebSocket `wss://agent.deepgram.com/v1/agent/converse` (`Welcome` -> `Settings` -> `SettingsApplied`)
 */
export async function verifyDeepgramConnection(explicitKey?: string): Promise<DeepgramDiagnosticResult> {
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

  const result: DeepgramDiagnosticResult = {
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
    } else if (res.status === 403) {
      // Valid key with restricted scopes (e.g. Usage/Voice Agent without projects:read)
      result.restAuth = { ok: true, status: 200, projectName: 'Scoped Key (Valid Auth)' };
    } else if (!res.ok) {
      const txt = await res.text();
      result.restAuth = {
        ok: false,
        status: res.status,
        error: `HTTP ${res.status}: ${txt.slice(0, 180)}`,
      };
      return result;
    } else {
      const data: any = await res.json();
      const firstProj = Array.isArray(data?.projects) ? data.projects[0]?.name : undefined;
      result.restAuth = { ok: true, status: 200, projectName: firstProj || 'Verified' };
    }
  } catch (err: any) {
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
    } else {
      const buf = await ttsRes.arrayBuffer();
      result.ttsSpeak = { ok: true, status: 200, bytes: buf.byteLength };
    }
  } catch (err: any) {
    result.ttsSpeak = { ok: false, error: err?.message || 'TTS request failed' };
  }

  // 3. Voice Agent WebSocket handshake check
  const agentUrl = (process.env.DEEPGRAM_AGENT_URL || '').trim() || 'wss://agent.deepgram.com/v1/agent/converse';
  const wsStartedAt = Date.now();
  const wsCheck = await new Promise<DeepgramDiagnosticResult['voiceAgentWs']>((resolve) => {
    let settled = false;
    let requestId = '';
    const done = (val: DeepgramDiagnosticResult['voiceAgentWs']) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close(1000, 'diagnostic_done');
      } catch {}
      resolve(val);
    };

    const ws = new WebSocket(agentUrl, {
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
      if (isBinary) return;
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'Welcome') {
          requestId = msg.request_id || '';
          ws.send(
            JSON.stringify({
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
            })
          );
        } else if (msg.type === 'SettingsApplied') {
          done({ ok: true, latencyMs: Math.max(1, Date.now() - wsStartedAt), requestId });
        } else if (msg.type === 'Error') {
          done({ ok: false, error: `${msg.code || 'Error'}: ${msg.description || JSON.stringify(msg)}` });
        }
      } catch {}
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
