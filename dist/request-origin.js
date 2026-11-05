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
    const peer = req.socket?.remoteAddress;
    const trusted = Boolean(peer && trustProxy && trustProxy(peer, 0));
    const host = (trusted && firstHeader(req.headers['x-forwarded-host'])) || firstHeader(req.headers.host);
    const forwardedProto = trusted && firstHeader(req.headers['x-forwarded-proto']);
    const protocol = forwardedProto || (req.socket?.encrypted ? 'https' : 'http');
    if (!host || !['http', 'https'].includes(protocol.toLowerCase()))
        return false;
    try {
        const requested = new URL(origin);
        const expected = new URL(`${protocol}://${host}`);
        if (!['http:', 'https:'].includes(requested.protocol) || requested.username || requested.password ||
            requested.pathname !== '/' || requested.search || requested.hash ||
            expected.username || expected.password || expected.pathname !== '/' || expected.search || expected.hash)
            return false;
        return requested.origin === expected.origin;
    }
    catch {
        return false;
    }
}
