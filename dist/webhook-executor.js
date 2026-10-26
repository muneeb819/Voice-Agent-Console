"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.executeCustomFunctionWebhook = executeCustomFunctionWebhook;
const env_store_1 = require("./env-store");
const settings_builder_1 = require("./settings-builder");
function interpolateTemplate(raw, ctx) {
    return String(raw || '').replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, token) => {
        if (token === 'caller_code')
            return ctx.callerCode || '';
        if (token === 'call_id')
            return ctx.callId || '';
        if (token === 'lead_id')
            return ctx.leadId || ctx.lead?.lead_id || '';
        if (token === 'phone' || token === 'phone_number')
            return ctx.phone || ctx.lead?.phone_number || '';
        if (token.startsWith('lead.')) {
            const key = token.slice(5);
            const val = ctx.lead?.[key] ?? ctx.lead?.custom?.[key];
            return val !== undefined && val !== null ? String(val) : '';
        }
        const envVal = process.env[token];
        if (envVal !== undefined) {
            return (0, env_store_1.sanitizeSecretValue)(envVal);
        }
        return '';
    });
}
function isBlockedMetadataHost(hostname) {
    const lower = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return (lower === '169.254.169.254' ||
        lower === 'fd00:ec2::254' ||
        lower === 'metadata.google.internal' ||
        lower === '100.100.100.200');
}
async function executeCustomFunctionWebhook(fnDef, args, ctx = {}, timeoutMs = 6000) {
    const started = Date.now();
    if (!fnDef || !fnDef.url || !fnDef.url.trim()) {
        return {
            ok: true,
            executedWebhook: false,
            latencyMs: 0,
            data: {
                ok: true,
                note: 'Function executed locally (no webhook URL configured)',
                received_args: args,
            },
        };
    }
    const resolvedUrlStr = interpolateTemplate(fnDef.url.trim(), ctx);
    let targetUrl;
    try {
        targetUrl = new URL(resolvedUrlStr);
    }
    catch {
        return {
            ok: false,
            executedWebhook: true,
            latencyMs: Date.now() - started,
            url: resolvedUrlStr,
            error: `Invalid webhook URL: ${resolvedUrlStr}`,
        };
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
    if (isBlockedMetadataHost(targetUrl.hostname)) {
        return {
            ok: false,
            executedWebhook: true,
            latencyMs: Date.now() - started,
            url: resolvedUrlStr,
            error: 'Blocked cloud metadata endpoint',
        };
    }
    const method = (fnDef.method || 'post').toUpperCase();
    const parsedHeaders = (0, settings_builder_1.parseJsonObject)(fnDef.headers || '{}');
    const headers = {
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
    let body;
    if (method === 'GET') {
        for (const [k, v] of Object.entries(args || {})) {
            if (v !== undefined && v !== null && typeof v !== 'object') {
                targetUrl.searchParams.set(k, String(v));
            }
        }
        if (ctx.leadId && !targetUrl.searchParams.has('lead_id')) {
            targetUrl.searchParams.set('lead_id', String(ctx.leadId));
        }
    }
    else {
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
        const res = await fetch(targetUrl.toString(), {
            method,
            headers,
            body,
            signal: AbortSignal.timeout(timeoutMs),
        });
        const rawText = (await res.text()).slice(0, 65536);
        let parsedData = rawText;
        try {
            parsedData = JSON.parse(rawText);
        }
        catch {
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
    }
    catch (err) {
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
