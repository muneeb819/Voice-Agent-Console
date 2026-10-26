"use strict";
/**
 * ITU-T G.711 mu-law (PCMU, 8 kHz) <-> 16-bit signed linear PCM (little-endian)
 * + RFC 3550 RTP packetizer/depacketizer for Asterisk 13/16/18+ SIP/RTP channels.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ulawToLinear16 = ulawToLinear16;
exports.linear16ToUlaw = linear16ToUlaw;
exports.downsample16kTo8kLinear16 = downsample16kTo8kLinear16;
exports.parseRtpPacket = parseRtpPacket;
exports.buildRtpPacket = buildRtpPacket;
exports.parseRfc4733Dtmf = parseRfc4733Dtmf;
const ULAW_DECODE_TABLE = new Int16Array(256);
const ULAW_BIAS = 0x84;
const ULAW_CLIP = 32635;
for (let i = 0; i < 256; i++) {
    const u = ~i & 0xff;
    const sign = u & 0x80;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    let sample = ((mantissa << 3) + ULAW_BIAS) << exponent;
    sample -= ULAW_BIAS;
    ULAW_DECODE_TABLE[i] = sign ? -sample : sample;
}
function encodeLinearSampleToUlaw(pcmVal) {
    let sign = 0;
    let sample = pcmVal;
    if (sample < 0) {
        sign = 0x80;
        sample = -sample;
    }
    if (sample > ULAW_CLIP) {
        sample = ULAW_CLIP;
    }
    sample += ULAW_BIAS;
    let exponent = 7;
    for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {
        // find segment exponent
    }
    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    return ~(sign | (exponent << 4) | mantissa) & 0xff;
}
function ulawToLinear16(ulawBuf) {
    const out = Buffer.allocUnsafe(ulawBuf.length * 2);
    for (let i = 0; i < ulawBuf.length; i++) {
        out.writeInt16LE(ULAW_DECODE_TABLE[ulawBuf[i]], i * 2);
    }
    return out;
}
function linear16ToUlaw(pcm16LeBuf) {
    const samples = Math.floor(pcm16LeBuf.length / 2);
    const out = Buffer.allocUnsafe(samples);
    for (let i = 0; i < samples; i++) {
        const s = pcm16LeBuf.readInt16LE(i * 2);
        out[i] = encodeLinearSampleToUlaw(s);
    }
    return out;
}
function downsample16kTo8kLinear16(pcm16At16k) {
    const inSamples = Math.floor(pcm16At16k.length / 2);
    const outSamples = Math.floor(inSamples / 2);
    const out = Buffer.allocUnsafe(outSamples * 2);
    for (let i = 0; i < outSamples; i++) {
        const s0 = pcm16At16k.readInt16LE(i * 4);
        const s1 = pcm16At16k.readInt16LE(i * 4 + 2);
        const avg = Math.max(-32768, Math.min(32767, Math.round((s0 + s1) / 2)));
        out.writeInt16LE(avg, i * 2);
    }
    return out;
}
function parseRtpPacket(buf) {
    if (buf.length < 12)
        return null;
    const first = buf[0];
    const version = (first >> 6) & 0x03;
    if (version !== 2)
        return null;
    const hasPadding = Boolean((first >> 5) & 0x01);
    const hasExtension = Boolean((first >> 4) & 0x01);
    const csrcCount = first & 0x0f;
    const second = buf[1];
    const marker = Boolean((second >> 7) & 0x01);
    const payloadType = second & 0x7f;
    const sequenceNumber = buf.readUInt16BE(2);
    const timestamp = buf.readUInt32BE(4);
    const ssrc = buf.readUInt32BE(8);
    let offset = 12 + csrcCount * 4;
    if (buf.length < offset)
        return null;
    if (hasExtension) {
        if (buf.length < offset + 4)
            return null;
        const extWords = buf.readUInt16BE(offset + 2);
        offset += 4 + extWords * 4;
        if (buf.length < offset)
            return null;
    }
    let end = buf.length;
    if (hasPadding && end > offset) {
        const padLen = buf[end - 1];
        if (padLen > 0 && end - padLen >= offset) {
            end -= padLen;
        }
    }
    return {
        version,
        marker,
        payloadType,
        sequenceNumber,
        timestamp,
        ssrc,
        payload: buf.subarray(offset, end),
    };
}
function buildRtpPacket(opts) {
    const pkt = Buffer.allocUnsafe(12 + opts.payload.length);
    pkt[0] = 0x80; // V=2, P=0, X=0, CC=0
    pkt[1] = ((opts.marker ? 1 : 0) << 7) | (opts.payloadType & 0x7f);
    pkt.writeUInt16BE(opts.sequenceNumber & 0xffff, 2);
    pkt.writeUInt32BE(opts.timestamp >>> 0, 4);
    pkt.writeUInt32BE(opts.ssrc >>> 0, 8);
    opts.payload.copy(pkt, 12);
    return pkt;
}
const RFC4733_DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '#', 'A', 'B', 'C', 'D'];
function parseRfc4733Dtmf(payload) {
    if (payload.length < 4)
        return null;
    const eventCode = payload[0];
    if (eventCode >= RFC4733_DIGITS.length)
        return null;
    const endOfEvent = Boolean(payload[1] & 0x80);
    return { digit: RFC4733_DIGITS[eventCode], endOfEvent };
}
