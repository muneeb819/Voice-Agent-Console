import dns from 'dns';
import http from 'http';
import https from 'https';
import net from 'net';
import { getSecret, sanitizeSecretValue } from './env-store';
import { readResponseText } from './http-limits';
import { parseJsonObject } from './settings-builder';
import { AgentFunction } from './types';

export interface WebhookCallContext {
  callId?: string;
  callerCode?: string;
  leadId?: string | null;
  phone?: string;
  campaignId?: string | null;
  viciCampaign?: string | null;
  lead?: Record<string, any>;
}

export interface WebhookExecutionResult {
  ok: boolean;
  executedWebhook: boolean;
  httpStatus?: number;
  latencyMs: number;
  url?: string;
  method?: string;
  data?: any;
  error?: string;
}

function interpolateTemplate(raw: string, ctx: WebhookCallContext): string {
  return String(raw || '').replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, token: string) => {
    if (token === 'caller_code') return ctx.callerCode || '';
    if (token === 'call_id') return ctx.callId || '';
    if (token === 'lead_id') return ctx.leadId || ctx.lead?.lead_id || '';
    if (token === 'phone' || token === 'phone_number') return ctx.phone || ctx.lead?.phone_number || '';
    if (token.startsWith('lead.')) {
      const key = token.slice(5);
      const val = ctx.lead?.[key] ?? ctx.lead?.custom?.[key];
      return val !== undefined && val !== null ? String(val) : '';
    }
    // Never expose arbitrary process environment (cloud credentials, PATH, etc.).
    if (token === 'CUSTOM_WEBHOOK_SECRET') return sanitizeSecretValue(getSecret('CUSTOM_WEBHOOK_SECRET'));
    return '';
  });
}

/** True for cloud metadata / link-local targets, in any spelling (IPv4, IPv6, IPv4-mapped IPv6). */
export function isBlockedMetadataAddress(raw: string): boolean {
  let lower = String(raw || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!lower) return false;
  if (lower === 'metadata.google.internal' || lower === 'metadata' || lower === 'instance-data') return true;
  // IPv4-mapped IPv6 (::ffff:a.b.c.d or ::ffff:a9fe:a9fe) -> dotted IPv4.
  const mapped = /^(?:0{0,4}:){0,5}ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(lower);
  if (mapped) {
    if (mapped[1]) lower = mapped[1];
    else {
      const hi = parseInt(mapped[2], 16);
      const lo = parseInt(mapped[3], 16);
      lower = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    }
  }
  if (net.isIPv4(lower)) {
    const [a, b] = lower.split('.').map(Number);
    return (a === 169 && b === 254) || lower === '100.100.100.200' || lower === '0.0.0.0';
  }
  if (net.isIPv6(lower)) {
    return lower === '::' || lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb') || lower.startsWith('fd00:ec2:');
  }
  return false;
}

/**
 * Connect-time DNS guard: the address that is actually dialed is the one that is
 * checked, so a hostname cannot pass a pre-check and then resolve to a metadata
 * address when the socket connects (DNS rebinding). Runs inside the request, so
 * the request timeout/abort also bounds the lookup.
 */
function guardedLookup(
  hostname: string,
  options: dns.LookupOptions | number | undefined,
  callback: (err: NodeJS.ErrnoException | null, address?: any, family?: number) => void
): void {
  const opts: dns.LookupOptions = typeof options === 'number' ? { family: options } : { ...(options || {}) };
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = addresses as dns.LookupAddress[];
    if (!list.length) return callback(Object.assign(new Error(`No address for ${hostname}`), { code: 'ENOTFOUND' }) as NodeJS.ErrnoException);
    if (list.some((a) => isBlockedMetadataAddress(a.address))) {
      return callback(Object.assign(new Error('Blocked cloud metadata endpoint'), { code: 'EBLOCKED' }) as NodeJS.ErrnoException);
    }
    if (opts.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

const MAX_WEBHOOK_BODY_BYTES = 65536;

/** HTTP(S) request with the connect-time guard, no redirects, bounded body. Resolves a standard Response. */
function guardedRequest(
  target: URL,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const mod = target.protocol === 'https:' ? https : http;
    const headers = { ...init.headers };
    if (init.body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(init.body));
    const req = mod.request(
      target,
      { method: init.method, headers, lookup: guardedLookup as any },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_WEBHOOK_BODY_BYTES) {
            req.destroy(new Error(`Upstream response exceeds ${MAX_WEBHOOK_BODY_BYTES} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => {
          const status = res.statusCode || 0;
          const noBody = status === 204 || status === 205 || status === 304;
          const h = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (Array.isArray(v)) v.forEach((x) => h.append(k, x));
            else if (v !== undefined) h.set(k, String(v));
          }
          try {
            resolve(new Response(noBody ? null : Buffer.concat(chunks, total), { status, headers: h }));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    const onAbort = () => req.destroy(init.signal.reason instanceof Error ? init.signal.reason : new Error('Webhook request aborted'));
    if (init.signal.aborted) onAbort();
    else init.signal.addEventListener('abort', onAbort, { once: true });
    req.on('error', reject);
    req.end(init.body);
  });
}

export async function executeCustomFunctionWebhook(
  fnDef: AgentFunction | undefined,
  args: Record<string, any>,
  ctx: WebhookCallContext = {},
  timeoutMs = 6000,
  signal?: AbortSignal
): Promise<WebhookExecutionResult> {
  const started = Date.now();
  if (!fnDef || !fnDef.url || !fnDef.url.trim()) {
    return {
      ok: false,
      executedWebhook: false,
      latencyMs: 0,
      error: 'No webhook URL is configured for this function.',
      data: { ok: false, error: 'No webhook URL is configured for this function.' },
    };
  }

  const resolvedUrlStr = interpolateTemplate(fnDef.url.trim(), ctx);
  let targetUrl: URL;
  try {
    targetUrl = new URL(resolvedUrlStr);
  } catch {
    return {
      ok: false,
      executedWebhook: true,
      latencyMs: Date.now() - started,
      url: resolvedUrlStr,
      error: `Invalid webhook URL: ${resolvedUrlStr}`,
    };
  }

  if (targetUrl.username || targetUrl.password) {
    return { ok: false, executedWebhook: true, latencyMs: Date.now() - started, error: 'Webhook URL must not embed credentials.' };
  }
  if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
    return {
      ok: false,
      executedWebhook: true,
      latencyMs: Date.now() - started,
      url: resolvedUrlStr,
      error: `Unsupported webhook protocol: ${targetUrl.protocol}`,
    };
  }

  if (isBlockedMetadataAddress(targetUrl.hostname)) {
    return {
      ok: false,
      executedWebhook: true,
      latencyMs: Date.now() - started,
      url: resolvedUrlStr,
      error: 'Blocked cloud metadata endpoint',
    };
  }

  const method = (fnDef.method || 'post').toUpperCase();
  const parsedHeaders = parseJsonObject(fnDef.headers || '{}');
  const headers: Record<string, string> = {
    Accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
    'User-Agent': 'VoiceAgentConsole-Webhook/1.0',
  };

  if (parsedHeaders.ok) {
    for (const [k, v] of Object.entries(parsedHeaders.value)) {
      if (v !== undefined && v !== null) {
        headers[k] = interpolateTemplate(String(v), ctx);
      }
    }
  }

  let body: string | undefined;
  if (method === 'GET') {
    for (const [k, v] of Object.entries(args || {})) {
      if (v !== undefined && v !== null && typeof v !== 'object') {
        targetUrl.searchParams.set(k, String(v));
      }
    }
    if (ctx.leadId && !targetUrl.searchParams.has('lead_id')) {
      targetUrl.searchParams.set('lead_id', String(ctx.leadId));
    }
  } else {
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }
    body = JSON.stringify({
      ...args,
      _call_context: {
        function_name: fnDef.name,
        call_id: ctx.callId || null,
        caller_code: ctx.callerCode || null,
        lead_id: ctx.leadId || null,
        phone: ctx.phone || null,
        vici_campaign: ctx.viciCampaign || null,
      },
    });
  }

  try {
    // Redirects are never followed: that would bypass the address guard and
    // forward interpolated credentials to another destination.
    const res = await guardedRequest(targetUrl, {
      method,
      headers,
      body,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
    if (res.status >= 300 && res.status < 400) {
      return { ok: false, executedWebhook: true, httpStatus: res.status, latencyMs: Date.now() - started,
        url: targetUrl.toString(), method, error: `Webhook redirects are not followed (HTTP ${res.status}).` };
    }

    const rawText = await readResponseText(res, 65536);
    let parsedData: any = rawText;
    try {
      parsedData = JSON.parse(rawText);
    } catch {
      // plain text response
    }

    return {
      ok: res.ok,
      executedWebhook: true,
      httpStatus: res.status,
      latencyMs: Date.now() - started,
      url: targetUrl.toString(),
      method,
      data: parsedData,
      ...(res.ok ? {} : { error: `HTTP ${res.status}: ${rawText.slice(0, 200)}` }),
    };
  } catch (err: any) {
    return {
      ok: false,
      executedWebhook: true,
      latencyMs: Date.now() - started,
      url: targetUrl.toString(),
      method,
      error: err?.message || 'Webhook request failed',
    };
  }
}
