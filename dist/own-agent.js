"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OwnAgentSession = exports.defaultOwnAgentDeps = exports.SentenceChunker = exports.OWN_AGENT_PATH = void 0;
exports.parseSettings = parseSettings;
exports.createOwnAgentServer = createOwnAgentServer;
const crypto_1 = __importDefault(require("crypto"));
const ws_1 = require("ws");
const env_store_1 = require("./env-store");
const own_llm_1 = require("./own-llm");
const speech_service_client_1 = require("./speech-service-client");
/**
 * The own voice engine.
 *
 * It listens on a local WebSocket and speaks the same message protocol the bridge already uses with Deepgram's
 * Voice Agent, but does the work itself: the caller's audio goes to your speech service (listening), the words go
 * to a language model (thinking), and the reply is spoken by your speech service (speaking). The bridge does not
 * change; it only connects to a different address.
 */
exports.OWN_AGENT_PATH = '/own-agent';
const FUNCTION_TIMEOUT_MS = 20_000;
const MAX_TOOL_ROUNDS = 4;
const MAX_HISTORY_MESSAGES = 40;
const FALLBACK_LINE = 'Sorry, I missed that. Could you say that again?';
// ------------------------------------------------------------------ sentences
const ABBREVIATIONS = /\b(?:mr|mrs|ms|dr|st|jr|sr|vs|etc|inc|no)\.$/i;
/** Turns streamed text into speakable pieces, so the first words can be spoken before the reply is finished. */
class SentenceChunker {
    buf = '';
    emitted = 0;
    push(delta) {
        this.buf += delta;
        const out = [];
        for (;;) {
            const cut = this.findCut();
            if (cut < 0)
                break;
            const piece = this.buf.slice(0, cut).trim();
            this.buf = this.buf.slice(cut);
            if (piece) {
                out.push(piece);
                this.emitted += 1;
            }
        }
        return out;
    }
    flush() {
        const rest = this.buf.trim();
        this.buf = '';
        return rest ? [rest] : [];
    }
    findCut() {
        const re = /([.!?]+["')\]]*)(\s+)|(\n+)/g;
        let m;
        while ((m = re.exec(this.buf))) {
            const end = m.index + m[0].length;
            const head = this.buf.slice(0, m.index + (m[1] ? m[1].length : 0));
            if (m[1] && ABBREVIATIONS.test(head))
                continue;
            if (m[1] && /\d\.$/.test(head) && /^\s*\d/.test(this.buf.slice(end)))
                continue; // 3. 5 / numbered lists mid-number
            if (head.trim().split(/\s+/).length < 2 && m[1] && !/[!?]/.test(m[1]))
                continue; // "Hi." alone stays with the next part
            return end;
        }
        // The first piece may break at a comma so speech starts sooner; later pieces wait for a full sentence.
        if (this.emitted === 0) {
            const comma = /[,;:]\s+/g;
            let c;
            while ((c = comma.exec(this.buf))) {
                if (this.buf.slice(0, c.index).trim().split(/\s+/).length >= 8)
                    return c.index + c[0].length;
            }
        }
        return -1;
    }
}
exports.SentenceChunker = SentenceChunker;
exports.defaultOwnAgentDeps = {
    openStt: (o) => {
        const ws = (0, speech_service_client_1.openSpeechServiceSttStream)({
            sampleRate: o.sampleRate,
            language: o.language,
            onReady: o.onReady,
            onPartial: o.onPartial,
            onFinal: (text) => o.onFinal(text),
            onError: o.onError,
        });
        return {
            send: (pcm) => {
                if (ws.readyState === ws_1.WebSocket.OPEN)
                    ws.send(pcm, { binary: true });
            },
            close: () => {
                try {
                    ws.close();
                }
                catch { }
            },
        };
    },
    synthesize: async (o) => {
        const q = new URLSearchParams();
        if (o.exaggeration !== undefined)
            q.set('exaggeration', String(o.exaggeration));
        if (o.temperature !== undefined)
            q.set('temperature', String(o.temperature));
        const res = await fetch(`${(0, speech_service_client_1.getSpeechServiceBaseUrl)()}/v1/audio/speech${q.size ? `?${q}` : ''}`, {
            method: 'POST',
            headers: { ...(0, speech_service_client_1.getSpeechServiceHeaders)(), 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: o.voice.startsWith('clone:') ? 'chatterbox' : 'kokoro',
                input: o.text,
                voice: o.voice,
                response_format: 'pcm',
                sample_rate: o.sampleRate,
                speed: o.speed,
                stream: true,
            }),
            signal: o.signal,
        });
        if (!res.ok || !res.body)
            throw new Error(`The speech service could not speak (${res.status})`);
        const body = res.body;
        return (async function* () {
            const reader = body.getReader();
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done)
                        return;
                    if (value?.length)
                        yield Buffer.from(value);
                }
            }
            finally {
                reader.releaseLock();
            }
        })();
    },
    chat: ({ providerType, ...req }) => (0, own_llm_1.streamChat)({ ...req, endpoint: (0, own_llm_1.resolveLlmEndpoint)(providerType, { ...process.env, OPENAI_API_KEY: (0, env_store_1.getSecret)('OPENAI_API_KEY'), GROQ_API_KEY: (0, env_store_1.getSecret)('GROQ_API_KEY') }) }),
};
/** Reads the Settings message the bridge sends and says plainly what this engine cannot do. */
function parseSettings(msg) {
    const agent = msg?.agent || {};
    const listenType = String(agent.listen?.provider?.type || '');
    if (listenType !== 'speech_service') {
        return { ok: false, error: 'The own voice engine needs the self-hosted speech service for listening. Choose it as the listening provider in Plug-ins.' };
    }
    const speak = agent.speak?.provider || {};
    const voice = String(speak.voice || '').trim();
    if (!voice || speak.type === 'deepgram') {
        return { ok: false, error: 'The own voice engine needs a self-hosted voice. Choose the speech service voice in Plug-ins or on the bot.' };
    }
    const think = agent.think?.provider || {};
    let style = new URLSearchParams();
    try {
        style = new URL(String(agent.speak?.endpoint?.url || '')).searchParams;
    }
    catch { }
    const num = (v) => (v !== null && Number.isFinite(Number(v)) ? Number(v) : undefined);
    const lang = String(agent.language || 'en').split(',')[0].trim() || 'en';
    const inRate = Number(msg?.audio?.input?.sample_rate) || 8000;
    const outRate = Number(msg?.audio?.output?.sample_rate) || 8000;
    if (![8000, 16000, 24000, 48000].includes(inRate)) {
        return { ok: false, error: `Caller audio at ${inRate} Hz is not supported by the speech service (use 8000, 16000, 24000 or 48000).` };
    }
    return {
        ok: true,
        config: {
            language: lang,
            inRate,
            outRate,
            providerType: String(think.type || ''),
            model: String(think.model || ''),
            temperature: typeof think.temperature === 'number' ? think.temperature : undefined,
            reasoning: typeof think.reasoning_mode === 'string' ? think.reasoning_mode : undefined,
            prompt: String(agent.think?.prompt || ''),
            tools: (Array.isArray(agent.think?.functions) ? agent.think.functions : [])
                .filter((f) => f && typeof f.name === 'string')
                .map((f) => ({ name: f.name, description: f.description, parameters: f.parameters })),
            voice,
            speed: num(style.get('speed')) ?? 1,
            exaggeration: num(style.get('exaggeration')),
            temperatureTts: num(style.get('temperature')),
            greeting: String(agent.greeting || '').trim(),
        },
    };
}
class OwnAgentSession {
    ws;
    deps;
    config = null;
    stt = null;
    sttReady = false;
    pendingAudio = [];
    history = [];
    extraPrompt = '';
    epoch = 0;
    abort = null;
    turnRunning = false;
    userSpeaking = false;
    failures = 0;
    closed = false;
    pendingFns = new Map();
    carry = Buffer.alloc(0);
    constructor(ws, deps = exports.defaultOwnAgentDeps) {
        this.ws = ws;
        this.deps = deps;
        ws.on('message', (raw, isBinary) => this.onMessage(raw, isBinary));
        ws.on('close', () => this.close());
        ws.on('error', () => this.close());
        this.send({ type: 'Welcome', request_id: crypto_1.default.randomUUID() });
    }
    send(obj) {
        if (this.ws.readyState === ws_1.WebSocket.OPEN)
            this.ws.send(JSON.stringify(obj));
    }
    sendAudio(pcm) {
        if (this.ws.readyState !== ws_1.WebSocket.OPEN || !pcm.length)
            return;
        const all = this.carry.length ? Buffer.concat([this.carry, pcm]) : pcm;
        const even = all.length - (all.length % 2); // keep 16-bit samples whole
        this.carry = all.subarray(even);
        if (even)
            this.ws.send(all.subarray(0, even), { binary: true });
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        this.epoch += 1;
        this.abort?.abort();
        for (const resolve of this.pendingFns.values())
            resolve(JSON.stringify({ error: 'The call ended.' }));
        this.pendingFns.clear();
        this.stt?.close();
        try {
            this.ws.close();
        }
        catch { }
    }
    fail(description, code) {
        this.send({ type: 'Error', description, code });
        this.close();
    }
    onMessage(raw, isBinary) {
        if (this.closed)
            return;
        if (isBinary) {
            const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
            if (this.stt && this.sttReady)
                this.stt.send(buf);
            else if (this.pendingAudio.length < 400)
                this.pendingAudio.push(buf);
            return;
        }
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        }
        catch {
            return;
        }
        switch (msg.type) {
            case 'Settings':
                this.applySettings(msg);
                break;
            case 'InjectAgentMessage':
                void this.inject(String(msg.message || ''));
                break;
            case 'InjectUserMessage':
                if (!this.turnRunning && msg.content)
                    void this.runTurn(String(msg.content));
                break;
            case 'UpdatePrompt':
                if (msg.prompt)
                    this.extraPrompt += `\n\n${String(msg.prompt)}`;
                break;
            case 'FunctionCallResponse': {
                const done = this.pendingFns.get(String(msg.id));
                if (done) {
                    this.pendingFns.delete(String(msg.id));
                    done(String(msg.content ?? ''));
                }
                break;
            }
            default:
                break; // KeepAlive and anything else needs no answer
        }
    }
    applySettings(msg) {
        if (this.config)
            return;
        const parsed = parseSettings(msg);
        if (!parsed.ok)
            return this.fail(parsed.error, 'OWN_ENGINE_UNSUPPORTED');
        this.config = parsed.config;
        this.stt = this.deps.openStt({
            sampleRate: parsed.config.inRate,
            language: parsed.config.language,
            onReady: () => {
                this.sttReady = true;
                for (const b of this.pendingAudio.splice(0))
                    this.stt?.send(b);
            },
            onPartial: (text) => this.onPartial(text),
            onFinal: (text) => this.onFinal(text),
            onError: (m) => this.send({ type: 'Warning', description: `Listening problem: ${m}`, code: 'OWN_STT' }),
        });
        this.send({ type: 'SettingsApplied' });
        if (parsed.config.greeting)
            void this.inject(parsed.config.greeting);
    }
    // -------------------------------------------------------------- listening
    onPartial(text) {
        if (this.closed || !text.trim() || this.userSpeaking)
            return;
        this.userSpeaking = true;
        this.send({ type: 'UserStartedSpeaking' });
        this.interrupt();
    }
    onFinal(text) {
        this.userSpeaking = false;
        const said = text.trim();
        if (this.closed || !said || !/[\p{L}\p{N}]/u.test(said))
            return;
        this.interrupt();
        this.send({ type: 'ConversationText', role: 'user', content: said });
        void this.runTurn(said);
    }
    /** The caller started talking: stop speaking and thinking about the old turn. */
    interrupt() {
        this.epoch += 1;
        this.abort?.abort();
        this.abort = null;
        for (const resolve of this.pendingFns.values())
            resolve(JSON.stringify({ error: 'The caller interrupted.' }));
        this.pendingFns.clear();
        this.carry = Buffer.alloc(0);
    }
    // -------------------------------------------------------------- speaking
    /** Says exactly this text (the opening line or a bridge message). Refused while a turn is in progress. */
    async inject(text) {
        const line = text.trim();
        if (!line || !this.config)
            return;
        if (this.turnRunning) {
            this.send({ type: 'InjectionRefused', message: 'The agent is speaking.' });
            return;
        }
        const epoch = ++this.epoch;
        const ac = (this.abort = new AbortController());
        this.turnRunning = true;
        try {
            this.history.push({ role: 'assistant', content: line });
            this.send({ type: 'ConversationText', role: 'assistant', content: line });
            const queue = new SpeechQueue(this, epoch, ac.signal);
            queue.add(line);
            if (await queue.finish())
                this.send({ type: 'AgentAudioDone' });
        }
        finally {
            if (epoch === this.epoch)
                this.turnRunning = false;
            else
                this.turnRunning = false;
        }
    }
    /** @internal used by SpeechQueue */
    async speakPiece(text, epoch, signal, onFirstAudio) {
        const cfg = this.config;
        const audio = await this.deps.synthesize({
            text,
            voice: cfg.voice,
            speed: cfg.speed,
            sampleRate: cfg.outRate,
            exaggeration: cfg.exaggeration,
            temperature: cfg.temperatureTts,
            signal,
        });
        let any = false;
        for await (const chunk of audio) {
            if (epoch !== this.epoch || this.closed)
                return any;
            if (!any) {
                any = true;
                onFirstAudio();
            }
            this.sendAudio(chunk);
        }
        return any;
    }
    /** @internal */
    announceSpeaking() {
        this.send({ type: 'AgentStartedSpeaking' });
    }
    /** @internal */
    warn(description, code) {
        this.send({ type: 'Warning', description, code });
    }
    isCurrent(epoch) {
        return !this.closed && epoch === this.epoch;
    }
    // -------------------------------------------------------------- thinking
    systemPrompt() {
        return `${this.config.prompt}${this.extraPrompt}`.trim();
    }
    trimHistory() {
        while (this.history.length > MAX_HISTORY_MESSAGES) {
            this.history.shift();
            while (this.history.length && (this.history[0].role === 'tool' || (this.history[0].role === 'assistant' && this.history[0].tool_calls)))
                this.history.shift();
        }
    }
    async runTurn(userText) {
        const cfg = this.config;
        if (!cfg || this.closed)
            return;
        const epoch = ++this.epoch;
        const ac = (this.abort = new AbortController());
        this.turnRunning = true;
        this.history.push({ role: 'user', content: userText });
        this.trimHistory();
        this.send({ type: 'AgentThinking', content: userText });
        const queue = new SpeechQueue(this, epoch, ac.signal);
        let spoke = false;
        try {
            for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
                const chunker = new SentenceChunker();
                let text = '';
                let calls = [];
                const stream = this.deps.chat({
                    providerType: cfg.providerType,
                    model: cfg.model,
                    messages: [{ role: 'system', content: this.systemPrompt() }, ...this.history],
                    tools: cfg.tools,
                    temperature: cfg.temperature,
                    reasoningEffort: cfg.reasoning,
                    signal: ac.signal,
                });
                for await (const ev of stream) {
                    if (!this.isCurrent(epoch))
                        return;
                    if (ev.type === 'text') {
                        text += ev.delta;
                        for (const piece of chunker.push(ev.delta))
                            queue.add(piece);
                    }
                    else
                        calls = ev.calls;
                }
                for (const piece of chunker.flush())
                    queue.add(piece);
                if (!this.isCurrent(epoch))
                    return;
                if (text.trim()) {
                    this.send({ type: 'ConversationText', role: 'assistant', content: text.trim() });
                    spoke = true;
                }
                this.history.push({
                    role: 'assistant',
                    content: text.trim() || null,
                    ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) } : {}),
                });
                if (!calls.length)
                    break;
                const results = await this.runFunctions(calls, epoch);
                if (!this.isCurrent(epoch))
                    return;
                for (const r of results)
                    this.history.push({ role: 'tool', tool_call_id: r.id, content: r.content });
            }
            this.failures = 0;
            if ((await queue.finish()) || spoke)
                this.send({ type: 'AgentAudioDone' });
        }
        catch (err) {
            if (!this.isCurrent(epoch))
                return; // the caller interrupted; nothing to report
            this.failures += 1;
            this.warn(String(err?.message || err).slice(0, 300), 'OWN_LLM');
            if (this.failures >= 3)
                return this.fail('The language model failed three times in a row.', 'OWN_LLM_FAILED');
            this.history.pop(); // forget the user line that got no answer, so the next try is clean
            const retry = new SpeechQueue(this, epoch, ac.signal);
            retry.add(FALLBACK_LINE);
            this.send({ type: 'ConversationText', role: 'assistant', content: FALLBACK_LINE });
            if (await retry.finish())
                this.send({ type: 'AgentAudioDone' });
        }
        finally {
            if (epoch === this.epoch)
                this.turnRunning = false;
        }
    }
    async runFunctions(calls, epoch) {
        const waits = calls.map((c) => new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.pendingFns.delete(c.id);
                resolve({ id: c.id, content: JSON.stringify({ error: 'The action took too long.' }) });
            }, FUNCTION_TIMEOUT_MS);
            this.pendingFns.set(c.id, (content) => {
                clearTimeout(timer);
                resolve({ id: c.id, content });
            });
        }));
        this.send({
            type: 'FunctionCallRequest',
            functions: calls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments, client_side: true })),
        });
        const out = await Promise.all(waits);
        return this.isCurrent(epoch) ? out : [];
    }
}
exports.OwnAgentSession = OwnAgentSession;
/** Speaks pieces in order. Each piece starts synthesising at once, so the next one is ready when the last ends. */
class SpeechQueue {
    session;
    epoch;
    signal;
    chain = Promise.resolve(false);
    started = false;
    constructor(session, epoch, signal) {
        this.session = session;
        this.epoch = epoch;
        this.signal = signal;
    }
    add(text) {
        const prev = this.chain;
        this.chain = (async () => {
            const before = await prev;
            if (!this.session.isCurrent(this.epoch))
                return before;
            try {
                const any = await this.session.speakPiece(text, this.epoch, this.signal, () => {
                    if (!this.started) {
                        this.started = true;
                        this.session.announceSpeaking();
                    }
                });
                return before || any;
            }
            catch (err) {
                if (this.session.isCurrent(this.epoch))
                    this.session.warn(`Speaking problem: ${String(err?.message || err).slice(0, 200)}`, 'OWN_TTS');
                return before;
            }
        })();
    }
    /** Resolves when everything queued has been sent. True when any audio went out. */
    finish() {
        return this.chain;
    }
}
const isLoopback = (addr) => !!addr && (addr === '::1' || addr === '127.0.0.1' || addr === '::ffff:127.0.0.1');
function createOwnAgentServer(deps = exports.defaultOwnAgentDeps) {
    const token = crypto_1.default.randomBytes(24).toString('hex');
    const wss = new ws_1.WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
    const sessions = new Set();
    wss.on('connection', (ws) => {
        const s = new OwnAgentSession(ws, deps);
        sessions.add(s);
        ws.on('close', () => sessions.delete(s));
    });
    return {
        url: (port) => `ws://127.0.0.1:${port}${exports.OWN_AGENT_PATH}?token=${token}`,
        handleUpgrade(req, socket, head) {
            const u = new URL(req.url || '/', 'http://local');
            if (u.pathname !== exports.OWN_AGENT_PATH)
                return false;
            const given = Buffer.from(u.searchParams.get('token') || '');
            const want = Buffer.from(token);
            const ok = isLoopback(req.socket.remoteAddress) && given.length === want.length && crypto_1.default.timingSafeEqual(given, want);
            if (!ok) {
                socket.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
                socket.destroy();
                return true;
            }
            wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
            return true;
        },
        close() {
            for (const s of sessions)
                s.close();
            wss.close();
        },
    };
}
