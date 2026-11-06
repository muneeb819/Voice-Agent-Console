"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runSimulatedViciBridgeCall = runSimulatedViciBridgeCall;
const crypto_1 = __importDefault(require("crypto"));
const dgram_1 = __importDefault(require("dgram"));
const http_1 = __importDefault(require("http"));
const net_1 = __importDefault(require("net"));
const ws_1 = __importStar(require("ws"));
const db_1 = require("./db");
const env_store_1 = require("./env-store");
const g711_1 = require("./g711");
const vici_bridge_1 = require("./vici-bridge");
async function synthesizeCallerVoice8kPcm(text, isSpanish = false) {
    const apiKey = (0, env_store_1.getSecret)('DEEPGRAM_API_KEY');
    if (!apiKey) {
        throw new Error('DEEPGRAM_API_KEY required to synthesize live 8kHz caller audio');
    }
    const url = isSpanish
        ? 'https://api.deepgram.com/v1/speak?model=aura-2-celeste-es&encoding=linear16&sample_rate=8000&container=none'
        : 'https://api.deepgram.com/v2/speak?model=flux-cole-en&encoding=linear16&sample_rate=8000&container=none';
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Token ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) {
        throw new Error(`Caller TTS synthesis failed (${res.status}): ${await res.text()}`);
    }
    return Buffer.from(await res.arrayBuffer());
}
async function runSimulatedViciBridgeCall(bridge, opts) {
    const callerCode = opts.callerCode || 'V1027153012000104892';
    const phone = opts.phone || '3055550192';
    const isMedicareScenario = opts.scenario.startsWith('medicare_');
    const stForExten = (0, db_1.getConsoleState)();
    const medCampIdx = stForExten.campaigns.findIndex((c) => c.id === 'c_medicare' || /medicare/i.test(c.viciCampaign || c.name));
    const defaultExten = isMedicareScenario && medCampIdx >= 0
        ? `${stForExten.vici.aiExten}${medCampIdx + 1}`
        : `${stForExten.vici.aiExten}1`;
    const exten = opts.exten || defaultExten;
    const scenarioUtterances = {
        qualified_xfer: 'Yes, I am 64 in Florida, I need final expense coverage, please connect me to your specialist now.',
        dnc_request: 'Stop calling my phone right now, put me on your do not call list immediately.',
        not_interested: 'No thank you, I am not interested at all, goodbye.',
        medicare_qualified_xfer: 'Yes, I have both Medicare Part A and Part B, and my current age is 71.',
        medicare_underage_dq: 'Yes I have Medicare, and my current age is 61 years old.',
        medicare_spanish_lang: 'Hola, disculpe, no hablo inglés, yo solo hablo español.',
    };
    const callerSpeechText = scenarioUtterances[opts.scenario] || scenarioUtterances.qualified_xfer;
    // Prepare caller PCM before installing shared routing overrides or opening
    // mock servers, so a provider synthesis failure leaves neither behind.
    let callerPcm8k;
    if (opts.upstream === 'deepgram') {
        const speech = await synthesizeCallerVoice8kPcm(callerSpeechText, opts.scenario === 'medicare_spanish_lang');
        // Append 1.4 seconds of trailing silence so Flux v2 EOT detects end-of-turn cleanly!
        callerPcm8k = Buffer.concat([speech, Buffer.alloc(8000 * 2 * 1.4, 0)]);
    }
    else {
        // Non-silent synthetic voice energy for mock_ai
        callerPcm8k = Buffer.alloc(320 * 8);
        for (let i = 0; i < callerPcm8k.length; i += 2) {
            callerPcm8k.writeInt16LE(3200, i);
        }
    }
    // 1. Ephemeral Mock VICIdial HTTP Server (/vicidial/non_agent_api.php & /agc/api.php)
    const viciRequests = [];
    const viciServer = http_1.default.createServer((req, res) => {
        const u = new URL(req.url || '/', 'http://localhost');
        const q = Object.fromEntries(u.searchParams.entries());
        const fn = q.function || '';
        viciRequests.push({ path: u.pathname, fn, query: q });
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        if (u.pathname.endsWith('/non_agent_api.php')) {
            if (fn === 'version') {
                res.end('VERSION: 2.14-891a BUILD: 260412-1120 DATE: 2026-10-27 15:30:12');
                return;
            }
            if (fn === 'lead_all_info') {
                const mockDob = isMedicareScenario ? '1955-04-10' : '1962-04-10';
                const mockAge = isMedicareScenario ? '71' : '64';
                const mockList = isMedicareScenario ? '2001' : '1001';
                const mockComment = isMedicareScenario ? 'Medicare OTC benefit file review' : 'Requested FE info online';
                res.end([
                    'lead_id|status|user|vendor_lead_code|list_id|phone_number|first_name|last_name|city|state|postal_code|date_of_birth|comments|age',
                    `${q.lead_id || '104892'}|NEW|6666|VLC-991|${mockList}|${phone}|Robert|Carter|Miami|FL|33101|${mockDob}|${mockComment}|${mockAge}`,
                ].join('\n'));
                return;
            }
            if (fn === 'lead_field_info') {
                const map = {
                    first_name: 'Robert',
                    last_name: 'Carter',
                    phone_number: phone,
                    state: 'FL',
                    age: '64',
                    comments: 'Requested FE info online',
                };
                res.end(map[q.field_name || ''] || '');
                return;
            }
            if (fn === 'update_lead') {
                res.end(`SUCCESS: update_lead LEAD HAS BEEN UPDATED - ${q.lead_id || phone}|${q.status || 'UPDATED'}`);
                return;
            }
            if (fn === 'add_dnc_phone') {
                res.end(`SUCCESS: add_dnc_phone DNC NUMBER HAS BEEN ADDED - 6666|${q.phone_number}|${q.campaign_id}`);
                return;
            }
        }
        if (u.pathname.endsWith('/agc/api.php') && fn === 'ra_call_control') {
            res.end(`SUCCESS: ra_call_control ${q.stage} - ${q.agent_user}|${q.value}|${q.ingroup_choices || q.phone_number || q.status || 'OK'}`);
            return;
        }
        res.end('SUCCESS: ok');
    });
    await new Promise((r) => viciServer.listen(0, 'localhost', () => r()));
    const viciPort = viciServer.address().port;
    const prevAgentUrl = process.env.DEEPGRAM_AGENT_URL;
    // Optional fast local Mock Deepgram Voice Agent server when upstream === 'mock_ai'
    let mockDgHttp = null;
    if (opts.upstream === 'mock_ai') {
        mockDgHttp = http_1.default.createServer();
        const mockWss = new ws_1.WebSocketServer({ server: mockDgHttp, path: '/v1/agent/converse' });
        mockWss.on('connection', (ws) => {
            let rxPcmBytes = 0;
            let responded = false;
            ws.on('message', (raw, isBin) => {
                if (isBin) {
                    const b = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
                    // Count non-silent caller speech bytes
                    let energy = 0;
                    for (let i = 0; i + 1 < b.length; i += 2) {
                        energy += Math.abs(b.readInt16LE(i));
                    }
                    if (energy > 500)
                        rxPcmBytes += b.length;
                    if (!responded && rxPcmBytes >= 960) {
                        responded = true;
                        ws.send(JSON.stringify({ type: 'UserStartedSpeaking' }));
                        ws.send(JSON.stringify({ type: 'ConversationText', role: 'user', content: callerSpeechText }));
                        ws.send(JSON.stringify({ type: 'AgentThinking' }));
                        if (opts.scenario === 'qualified_xfer' || opts.scenario === 'medicare_qualified_xfer') {
                            const isMed = opts.scenario === 'medicare_qualified_xfer';
                            ws.send(JSON.stringify({
                                type: 'FunctionCallRequest',
                                functions: [
                                    {
                                        id: 'fc_1',
                                        name: 'set_disposition',
                                        arguments: JSON.stringify({
                                            code: 'XFER',
                                            notes: isMed
                                                ? 'Qualified Medicare Part A & B, Age 71, Hook: Food & OTC Card'
                                                : 'Robert age 64 FL qualified',
                                        }),
                                        client_side: true,
                                    },
                                    {
                                        id: 'fc_2',
                                        name: 'transfer_to_live_agent',
                                        arguments: JSON.stringify(isMed
                                            ? {
                                                reason: 'Qualified Medicare beneficiary ready for Food & OTC benefit review',
                                                prospect_name: 'Robert',
                                                confirmed_age: '71',
                                                medicare_status: 'Medicare Part A & B',
                                                hook_type: 'Food & OTC Card',
                                            }
                                            : { reason: 'Robert age 64 in FL wants FE quote', confirmed_age: '64' }),
                                        client_side: true,
                                    },
                                ],
                            }));
                        }
                        else {
                            const code = opts.scenario === 'dnc_request'
                                ? 'DNC'
                                : opts.scenario === 'medicare_spanish_lang'
                                    ? 'LANG'
                                    : opts.scenario === 'medicare_underage_dq'
                                        ? 'DQ'
                                        : 'NI';
                            ws.send(JSON.stringify({
                                type: 'FunctionCallRequest',
                                functions: [
                                    {
                                        id: 'fc_1',
                                        name: 'set_disposition',
                                        arguments: JSON.stringify({ code, notes: callerSpeechText }),
                                        client_side: true,
                                    },
                                    {
                                        id: 'fc_2',
                                        name: 'end_call',
                                        arguments: '{}',
                                        client_side: true,
                                    },
                                ],
                            }));
                        }
                    }
                    return;
                }
                const msg = JSON.parse(raw.toString());
                if (msg.type === 'Settings') {
                    ws.send(JSON.stringify({ type: 'SettingsApplied' }));
                }
                else if (msg.type === 'InjectAgentMessage' && typeof msg.message === 'string') {
                    ws.send(JSON.stringify({ type: 'AgentStartedSpeaking' }));
                    ws.send(JSON.stringify({
                        type: 'ConversationText',
                        role: 'assistant',
                        content: msg.message,
                    }));
                    // Send 4 frames (1280 bytes = 80ms) of 8kHz bot greeting tone
                    const greetingTone = Buffer.alloc(1280, 0x18);
                    ws.send(greetingTone, { binary: true });
                    setTimeout(() => {
                        if (ws.readyState === ws_1.default.OPEN) {
                            ws.send(JSON.stringify({ type: 'AgentAudioDone' }));
                        }
                    }, 90);
                }
                else if (msg.type === 'FunctionCallResponse' && msg.id === 'fc_2') {
                    ws.send(JSON.stringify({ type: 'AgentStartedSpeaking' }));
                    ws.send(JSON.stringify({
                        type: 'ConversationText',
                        role: 'assistant',
                        content: opts.scenario === 'qualified_xfer'
                            ? 'Thank you Robert, connecting you to our licensed specialist right now!'
                            : 'Understood Robert, I have updated our records. Have a good day, goodbye.',
                    }));
                    ws.send(Buffer.alloc(960, 0x14), { binary: true });
                    setTimeout(() => {
                        if (ws.readyState === ws_1.default.OPEN) {
                            ws.send(JSON.stringify({ type: 'AgentAudioDone' }));
                        }
                    }, 80);
                }
            });
            ws.send(JSON.stringify({ type: 'Welcome', request_id: 'req_vici_loopback' }));
        });
        await new Promise((r) => mockDgHttp.listen(0, 'localhost', () => r()));
        const mPort = mockDgHttp.address().port;
        process.env.DEEPGRAM_AGENT_URL = `ws://localhost:${mPort}/v1/agent/converse`;
    }
    bridge.setViciApiBaseOverride(`http://localhost:${viciPort}`);
    const previousCallIds = new Set((0, db_1.listBridgeCallLogs)(200).map((call) => call.id));
    const previousActiveCallIds = new Set(bridge.getStatus().activeCalls.map((call) => call.callId));
    const statusBefore = bridge.getStatus();
    let rxAudioFramesFromBot = 0;
    let rxAudioBytesFromBot = 0;
    try {
        if (opts.transport === 'audiosocket') {
            const reg = bridge.registerPreCall({
                uniqueid: `${Date.now()}.101`,
                vici_cid: callerCode,
                phone,
                exten,
                channel: 'SIP/carrier-00000101',
            });
            await new Promise((resolve, reject) => {
                const sock = net_1.default.createConnection({ host: 'localhost', port: statusBefore.audioSocketPort });
                let rxBuf = Buffer.alloc(0);
                let speechSent = false;
                let speechTimer = null;
                const maxWait = setTimeout(() => {
                    if (speechTimer)
                        clearInterval(speechTimer);
                    sock.destroy();
                    resolve();
                }, opts.upstream === 'deepgram' ? 35000 : 5000);
                sock.on('connect', () => {
                    // Send 0x01 16-byte UUID frame
                    const uuidBytes = (0, vici_bridge_1.canonicalUuidToBytes)(reg.uuid);
                    const hdr = Buffer.from([0x01, 0x00, 0x10]);
                    sock.write(Buffer.concat([hdr, uuidBytes]));
                });
                const startStreamingCallerPcm = () => {
                    if (speechSent)
                        return;
                    speechSent = true;
                    let offset = 0;
                    speechTimer = setInterval(() => {
                        if (!sock.writable || offset >= callerPcm8k.length) {
                            if (speechTimer)
                                clearInterval(speechTimer);
                            return;
                        }
                        const chunk = callerPcm8k.subarray(offset, Math.min(offset + 320, callerPcm8k.length));
                        offset += 320;
                        const frame = Buffer.alloc(320, 0);
                        chunk.copy(frame);
                        const h = Buffer.from([0x10, 0x01, 0x40]);
                        sock.write(Buffer.concat([h, frame]));
                    }, 20);
                };
                sock.on('data', (chunk) => {
                    rxBuf = Buffer.concat([rxBuf, chunk]);
                    while (rxBuf.length >= 3) {
                        const kind = rxBuf[0];
                        const len = rxBuf.readUInt16BE(1);
                        if (rxBuf.length < 3 + len)
                            break;
                        rxBuf = rxBuf.subarray(3 + len);
                        if (kind === 0x10) {
                            rxAudioFramesFromBot += 1;
                            rxAudioBytesFromBot += len;
                            // Trigger caller speech 420ms after bot greeting frames finish arriving!
                            if (!speechSent) {
                                if (sock._greetSilenceTimer)
                                    clearTimeout(sock._greetSilenceTimer);
                                sock._greetSilenceTimer = setTimeout(() => {
                                    startStreamingCallerPcm();
                                }, opts.upstream === 'deepgram' ? 420 : 120);
                            }
                        }
                        else if (kind === 0x00) {
                            clearTimeout(maxWait);
                            if (speechTimer)
                                clearInterval(speechTimer);
                            sock.end();
                            resolve();
                            return;
                        }
                    }
                });
                sock.on('close', () => {
                    clearTimeout(maxWait);
                    if (speechTimer)
                        clearInterval(speechTimer);
                    resolve();
                });
                sock.on('error', (err) => {
                    clearTimeout(maxWait);
                    if (speechTimer)
                        clearInterval(speechTimer);
                    reject(err);
                });
            });
        }
        else {
            // SIP + RTP (G.711 PCMU 8kHz) loopback client
            await new Promise(async (resolve, reject) => {
                const sipClient = dgram_1.default.createSocket('udp4');
                const rtpClient = dgram_1.default.createSocket('udp4');
                await new Promise((r) => sipClient.bind(0, 'localhost', () => r()));
                await new Promise((r) => rtpClient.bind(0, 'localhost', () => r()));
                const localSipPort = sipClient.address().port;
                const localRtpPort = rtpClient.address().port;
                const sipCallId = `${crypto_1.default.randomUUID()}@localhost`;
                const fromTag = `ast${crypto_1.default.randomBytes(4).toString('hex')}`;
                let remoteRtpPort = 0;
                let speechStarted = false;
                let rtpTimer = null;
                const cleanup = () => {
                    if (rtpTimer)
                        clearInterval(rtpTimer);
                    try {
                        sipClient.close();
                    }
                    catch { }
                    try {
                        rtpClient.close();
                    }
                    catch { }
                };
                const maxWait = setTimeout(() => {
                    cleanup();
                    resolve();
                }, opts.upstream === 'deepgram' ? 35000 : 5000);
                const startCallerRtp = () => {
                    if (speechStarted || !remoteRtpPort)
                        return;
                    speechStarted = true;
                    let offset = 0;
                    let seq = 100;
                    let ts = 1600;
                    const ssrc = 0x12345678;
                    rtpTimer = setInterval(() => {
                        if (offset >= callerPcm8k.length) {
                            if (rtpTimer)
                                clearInterval(rtpTimer);
                            return;
                        }
                        const pcmSlice = callerPcm8k.subarray(offset, Math.min(offset + 320, callerPcm8k.length));
                        offset += 320;
                        const padded = Buffer.alloc(320, 0);
                        pcmSlice.copy(padded);
                        const ulaw = (0, g711_1.linear16ToUlaw)(padded);
                        const pkt = (0, g711_1.buildRtpPacket)({
                            payloadType: 0,
                            sequenceNumber: seq++,
                            timestamp: ts,
                            ssrc,
                            marker: seq === 101,
                            payload: ulaw,
                        });
                        ts += 160;
                        rtpClient.send(pkt, remoteRtpPort, 'localhost');
                    }, 20);
                };
                rtpClient.on('message', (pktBuf) => {
                    const parsed = (0, g711_1.parseRtpPacket)(pktBuf);
                    if (parsed && parsed.payloadType === 0) {
                        rxAudioFramesFromBot += 1;
                        rxAudioBytesFromBot += parsed.payload.length;
                        if (!speechStarted && remoteRtpPort) {
                            if (rtpClient._greetSilenceTimer)
                                clearTimeout(rtpClient._greetSilenceTimer);
                            rtpClient._greetSilenceTimer = setTimeout(() => {
                                startCallerRtp();
                            }, opts.upstream === 'deepgram' ? 420 : 120);
                        }
                    }
                });
                sipClient.on('message', (buf, rinfo) => {
                    const txt = buf.toString('utf8');
                    if (txt.startsWith('SIP/2.0 200')) {
                        const mAudio = /^m=audio\s+(\d+)\s+RTP\/AVP/m.exec(txt);
                        if (mAudio)
                            remoteRtpPort = Number(mAudio[1]);
                        const toMatch = /^To:\s*(.+)$/im.exec(txt);
                        const ack = [
                            `ACK sip:${exten}@localhost:${statusBefore.sipPort} SIP/2.0`,
                            `Via: SIP/2.0/UDP localhost:${localSipPort};branch=z9hG4bKack1`,
                            `From: "${callerCode}" <sip:${phone}@localhost>;tag=${fromTag}`,
                            `To: ${toMatch ? toMatch[1].trim() : `<sip:${exten}@localhost>`}`,
                            `Call-ID: ${sipCallId}`,
                            'CSeq: 102 ACK',
                            'Content-Length: 0',
                            '',
                            '',
                        ].join('\r\n');
                        sipClient.send(Buffer.from(ack, 'utf8'), rinfo.port, rinfo.address);
                    }
                    else if (txt.startsWith('BYE ')) {
                        const viaM = /^Via:\s*(.+)$/im.exec(txt);
                        const fromM = /^From:\s*(.+)$/im.exec(txt);
                        const toM = /^To:\s*(.+)$/im.exec(txt);
                        const cseqM = /^CSeq:\s*(.+)$/im.exec(txt);
                        const okBye = [
                            'SIP/2.0 200 OK',
                            `Via: ${viaM ? viaM[1].trim() : ''}`,
                            `From: ${fromM ? fromM[1].trim() : ''}`,
                            `To: ${toM ? toM[1].trim() : ''}`,
                            `Call-ID: ${sipCallId}`,
                            `CSeq: ${cseqM ? cseqM[1].trim() : '1 BYE'}`,
                            'Content-Length: 0',
                            '',
                            '',
                        ].join('\r\n');
                        sipClient.send(Buffer.from(okBye, 'utf8'), rinfo.port, rinfo.address);
                        clearTimeout(maxWait);
                        cleanup();
                        resolve();
                    }
                });
                sipClient.on('error', (err) => {
                    clearTimeout(maxWait);
                    cleanup();
                    reject(err);
                });
                const sdpOffer = [
                    'v=0',
                    `o=root 12345 12345 IN IP4 localhost`,
                    's=Asterisk PBX 18.20.0',
                    'c=IN IP4 localhost',
                    't=0 0',
                    `m=audio ${localRtpPort} RTP/AVP 0 101`,
                    'a=rtpmap:0 PCMU/8000',
                    'a=rtpmap:101 telephone-event/8000',
                    'a=ptime:20',
                    'a=sendrecv',
                    '',
                ].join('\r\n');
                const invite = [
                    `INVITE sip:${exten}@localhost:${statusBefore.sipPort} SIP/2.0`,
                    `Via: SIP/2.0/UDP localhost:${localSipPort};branch=z9hG4bKinv1;rport`,
                    `From: "${callerCode}" <sip:${phone}@localhost>;tag=${fromTag}`,
                    `To: <sip:${exten}@localhost:${statusBefore.sipPort}>`,
                    `Contact: <sip:${phone}@localhost:${localSipPort}>`,
                    `Call-ID: ${sipCallId}`,
                    'CSeq: 102 INVITE',
                    `X-Vici-CallName: ${callerCode}`,
                    `X-Vici-Exten: ${exten}`,
                    'Content-Type: application/sdp',
                    `Content-Length: ${Buffer.byteLength(sdpOffer, 'utf8')}`,
                    '',
                    sdpOffer,
                ].join('\r\n');
                sipClient.send(Buffer.from(invite, 'utf8'), statusBefore.sipPort, 'localhost');
            });
        }
        const activeTestCall = bridge.getStatus().activeCalls.find((call) => !previousActiveCallIds.has(call.callId) &&
            call.transport === opts.transport &&
            call.exten === exten &&
            call.callerCode === callerCode);
        if (activeTestCall)
            bridge.forceHangupCall(activeTestCall.callId);
        const cdrDeadline = Date.now() + 5000;
        let cdr = (0, db_1.listBridgeCallLogs)(200).find((call) => !previousCallIds.has(call.id) &&
            call.transport === opts.transport &&
            call.exten === exten &&
            call.callerCode === callerCode);
        while (!cdr && Date.now() < cdrDeadline) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            cdr = (0, db_1.listBridgeCallLogs)(200).find((call) => !previousCallIds.has(call.id) &&
                call.transport === opts.transport &&
                call.exten === exten &&
                call.callerCode === callerCode);
        }
        if (!cdr) {
            throw new Error(`Timed out waiting for the ${opts.transport} simulation CDR to persist`);
        }
        return {
            ok: true,
            transport: opts.transport,
            scenario: opts.scenario,
            upstream: opts.upstream,
            rxAudioFramesFromBot,
            rxAudioBytesFromBot,
            callerFramesReceived: rxAudioFramesFromBot,
            viciRequests,
            viciRequestsReceived: viciRequests,
            latestCdr: cdr,
            cdr,
        };
    }
    finally {
        bridge.setViciApiBaseOverride(undefined);
        if (prevAgentUrl === undefined)
            delete process.env.DEEPGRAM_AGENT_URL;
        else
            process.env.DEEPGRAM_AGENT_URL = prevAgentUrl;
        viciServer.closeAllConnections?.();
        viciServer.close();
        if (mockDgHttp) {
            mockDgHttp.closeAllConnections?.();
            mockDgHttp.close();
        }
    }
}
