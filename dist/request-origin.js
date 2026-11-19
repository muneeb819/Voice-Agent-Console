"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isSameOriginRequest = isSameOriginRequest;
function firstHeader(value) {
    return String(Array.isArray(value) ? value[0] || '' : value || '').split(',')[0].trim();
}
/**
 * Browsers send Origin on WebSocket upgrades and cross-origin requests. Reject
 * a supplied Origin unless it matches the externally visible request origin.
 * Requests without Origin remain available to non-browser clients such as the
 * Asterisk dialplan. Forwarded host/protocol are considered only from a proxy
 * explicitly trusted by Express.
 */
function isSameOriginRequest(req, trustProxy) {
    const originHeader = req.headers.origin;
    if (originHeader === undefined)
        return true;
    if (Array.isArray(originHeader) || !originHeader.trim() || originHeader.includes(','))
        return false;
    const origin = originHeader.trim();
    let requested;
    try {
        requested = new URL(origin);
    }
    catch {
        return false;
    }
    if (!['http:', 'https:'].includes(requested.protocol) || requested.username || requested.password ||
        requested.pathname !== '/' || requested.search || requested.hash)
        return false;
    // A TLS-terminating reverse proxy may report the upstream scheme as http
    // while the browser origin is https, and may rewrite Host. Compare the
    // browser-visible host against every trusted host candidate, using the
    // origin's own scheme so default-port normalization stays consistent.
    const peer = req.socket?.remoteAddress;
    const trusted = Boolean(peer && trustProxy && trustProxy(peer, 0));
    const hosts = [];
    if (trusted)
        hosts.push(firstHeader(req.headers['x-forwarded-host']));
    hosts.push(firstHeader(req.headers.host));
    for (const host of hosts) {
        if (!host)
            continue;
        try {
            const expected = new URL(`${requested.protocol}//${host}`);
            if (expected.username || expected.password || expected.pathname !== '/' || expected.search || expected.hash)
                continue;
            if (expected.host === requested.host)
                return true;
        }
        catch {
            // Ignore malformed proxy headers and try the next candidate.
        }
    }
    // Browsers set Sec-Fetch-Site as a forbidden header. A same-origin assertion
    // is a safe fallback when an intermediary rewrites both Host and the
    // forwarded-host header. Non-browser clients can already omit Origin.
    const site = String(firstHeader(req.headers['sec-fetch-site'])).toLowerCase();
    return site === 'same-origin';
}
