import crypto from 'crypto';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { RawData, WebSocket, WebSocketServer } from 'ws';
import { getSecret } from './env-store';
import { type ChatMessage, type ChatRequest, type ChatTool, type LlmEvent, resolveLlmEndpoint, streamChat } from './own-llm';
import {
  getSpeechServiceBaseUrl,
  getSpeechServiceHeaders,
  openSpeechServiceSttStream,
} from './speech-service-client';

/**
 * The own voice engine.
 *
 * It listens on a local WebSocket and speaks the same message protocol the bridge already uses with Deepgram's
 * Voice Agent, but does the work itself: the caller's audio goes to your speech service (listening), the words go
 * to a language model (thinking), and the reply is spoken by your speech service (speaking). The bridge does not
 * change; it only connects to a different address.
 */

export const OWN_AGENT_PATH = '/own-agent';
const FUNCTION_TIMEOUT_MS = 20_000;
const MAX_TOOL_ROUNDS = 4;
const MAX_HISTORY_MESSAGES = 40;
const FALLBACK_LINE = 'Sorry, I missed that. Could you say that again?';

// ------------------------------------------------------------------ sentences

const ABBREVIATIONS = /\b(?:mr|mrs|ms|dr|st|jr|sr|vs|etc|inc|no)\.$/i;

/** Turns streamed text into speakable pieces, so the first words can be spoken before the reply is finished. */
export class SentenceChunker {
  private buf = '';
  private emitted = 0;

  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    for (;;) {
      const cut = this.findCut();
      if (cut < 0) break;
      const piece = this.buf.slice(0, cut).trim();
      this.buf = this.buf.slice(cut);
      if (piece) {
        out.push(piece);
        this.emitted += 1;
      }
    }
    return out;
  }

  flush(): string[] {
    const rest = this.buf.trim();
    this.buf = '';
    return rest ? [rest] : [];
  }

  private findCut(): number {
    const re = /([.!?]+["')\]]*)(\s+)|(\n+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.buf))) {
      const end = m.index + m[0].length;
      const head = this.buf.slice(0, m.index + (m[1] ? m[1].length : 0));
      if (m[1] && ABBREVIATIONS.test(head)) continue;
      if (m[1] && /\d\.$/.test(head) && /^\s*\d/.test(this.buf.slice(end))) continue; // 3. 5 / numbered lists mid-number
      if (head.trim().split(/\s+/).length < 2 && m[1] && !/[!?]/.test(m[1])) continue; // "Hi." alone stays with the next part
      return end;
    }
    // The first piece may break at a comma so speech starts sooner; later pieces wait for a full sentence.
    if (this.emitted === 0) {
      const comma = /[,;:]\s+/g;
      let c: RegExpExecArray | null;
      while ((c = comma.exec(this.buf))) {
        if (this.buf.slice(0, c.index).trim().split(/\s+/).length >= 8) return c.index + c[0].length;
      }
    }
    return -1;
  }
}

// ------------------------------------------------------------------ dependencies

export interface SttHandle {
  send(pcm: Buffer): void;
  close(): void;
}

export interface OwnAgentDeps {
  openStt(opts: {
    sampleRate: number;
    language: string;
    onReady: () => void;
    onPartial: (text: string) => void;
    onFinal: (text: string) => void;
    onError: (message: string) => void;
  }): SttHandle;
  /** Speaks one piece of text; yields raw 16-bit audio at `sampleRate` as it is produced. */
  synthesize(opts: {
    text: string;
    voice: string;
    speed: number;
    sampleRate: number;
    exaggeration?: number;
    temperature?: number;
    signal: AbortSignal;
  }): Promise<AsyncIterable<Buffer>>;
  chat(req: Omit<ChatRequest, 'endpoint'> & { providerType: string }): AsyncGenerator<LlmEvent>;
}

export const defaultOwnAgentDeps: OwnAgentDeps = {
  openStt: (o) => {
    const ws = openSpeechServiceSttStream({
      sampleRate: o.sampleRate as 8000 | 16000 | 24000 | 48000,
      language: o.language,
      onReady: o.onReady,
      onPartial: o.onPartial,
      onFinal: (text) => o.onFinal(text),
      onError: o.onError,
    });
    return {
      send: (pcm) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(pcm, { binary: true });
      },
      close: () => {
        try {
          ws.close();
        } catch {}
      },
    };
  },
  synthesize: async (o) => {
    const q = new URLSearchParams();
    if (o.exaggeration !== undefined) q.set('exaggeration', String(o.exaggeration));
    if (o.temperature !== undefined) q.set('temperature', String(o.temperature));
    const res = await fetch(`${getSpeechServiceBaseUrl()}/v1/audio/speech${q.size ? `?${q}` : ''}`, {
      method: 'POST',
      headers: { ...getSpeechServiceHeaders(), 'Content-Type': 'application/json' },
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
    if (!res.ok || !res.body) throw new Error(`The speech service could not speak (${res.status})`);
    const body = res.body;
    return (async function* () {
      const reader = body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          if (value?.length) yield Buffer.from(value);
        }
      } finally {
        reader.releaseLock();
      }
    })();
  },
  chat: ({ providerType, ...req }) =>
    streamChat({ ...req, endpoint: resolveLlmEndpoint(providerType, { ...process.env, OPENAI_API_KEY: getSecret('OPENAI_API_KEY'), GROQ_API_KEY: getSecret('GROQ_API_KEY') }) }),
};

// ------------------------------------------------------------------ one call

interface SessionConfig {
  language: string;
  inRate: number;
  outRate: number;
  providerType: string;
  model: string;
  temperature?: number;
  reasoning?: string;
  prompt: string;
  tools: ChatTool[];
  voice: string;
  speed: number;
  exaggeration?: number;
  temperatureTts?: number;
  greeting: string;
}

/** Reads the Settings message the bridge sends and says plainly what this engine cannot do. */
export function parseSettings(msg: any): { ok: true; config: SessionConfig } | { ok: false; error: string } {
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
  } catch {}
  const num = (v: string | null) => (v !== null && Number.isFinite(Number(v)) ? Number(v) : undefined);
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
        .filter((f: any) => f && typeof f.name === 'string')
        .map((f: any) => ({ name: f.name, description: f.description, parameters: f.parameters })),
      voice,
      speed: num(style.get('speed')) ?? 1,
      exaggeration: num(style.get('exaggeration')),
      temperatureTts: num(style.get('temperature')),
      greeting: String(agent.greeting || '').trim(),
    },
  };
}

export class OwnAgentSession {
  private config: SessionConfig | null = null;
  private stt: SttHandle | null = null;
  private sttReady = false;
  private pendingAudio: Buffer[] = [];
  private history: ChatMessage[] = [];
  private extraPrompt = '';
  private epoch = 0;
  private abort: AbortController | null = null;
  private turnRunning = false;
  private userSpeaking = false;
  private failures = 0;
  private closed = false;
  private pendingFns = new Map<string, (content: string) => void>();
  private carry: Buffer = Buffer.alloc(0);

  constructor(private readonly ws: WebSocket, private readonly deps: OwnAgentDeps = defaultOwnAgentDeps) {
    ws.on('message', (raw, isBinary) => this.onMessage(raw, isBinary));
    ws.on('close', () => this.close());
    ws.on('error', () => this.close());
    this.send({ type: 'Welcome', request_id: crypto.randomUUID() });
  }

  private send(obj: Record<string, any>): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  private sendAudio(pcm: Buffer): void {
    if (this.ws.readyState !== WebSocket.OPEN || !pcm.length) return;
    const all = this.carry.length ? Buffer.concat([this.carry, pcm]) : pcm;
    const even = all.length - (all.length % 2); // keep 16-bit samples whole
    this.carry = all.subarray(even);
    if (even) this.ws.send(all.subarray(0, even), { binary: true });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.epoch += 1;
    this.abort?.abort();
    for (const resolve of this.pendingFns.values()) resolve(JSON.stringify({ error: 'The call ended.' }));
    this.pendingFns.clear();
    this.stt?.close();
    try {
      this.ws.close();
    } catch {}
  }

  private fail(description: string, code: string): void {
    this.send({ type: 'Error', description, code });
    this.close();
  }

  private onMessage(raw: RawData, isBinary: boolean): void {
    if (this.closed) return;
    if (isBinary) {
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
      if (this.stt && this.sttReady) this.stt.send(buf);
      else if (this.pendingAudio.length < 400) this.pendingAudio.push(buf);
      return;
    }
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
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
        if (!this.turnRunning && msg.content) void this.runTurn(String(msg.content));
        break;
      case 'UpdatePrompt':
        if (msg.prompt) this.extraPrompt += `\n\n${String(msg.prompt)}`;
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

  private applySettings(msg: any): void {
    if (this.config) return;
    const parsed = parseSettings(msg);
    if (!parsed.ok) return this.fail(parsed.error, 'OWN_ENGINE_UNSUPPORTED');
    this.config = parsed.config;
    this.stt = this.deps.openStt({
      sampleRate: parsed.config.inRate,
      language: parsed.config.language,
      onReady: () => {
        this.sttReady = true;
        for (const b of this.pendingAudio.splice(0)) this.stt?.send(b);
      },
      onPartial: (text) => this.onPartial(text),
      onFinal: (text) => this.onFinal(text),
      onError: (m) => this.send({ type: 'Warning', description: `Listening problem: ${m}`, code: 'OWN_STT' }),
    });
    this.send({ type: 'SettingsApplied' });
    if (parsed.config.greeting) void this.inject(parsed.config.greeting);
  }

  // -------------------------------------------------------------- listening

  private onPartial(text: string): void {
    if (this.closed || !text.trim() || this.userSpeaking) return;
    this.userSpeaking = true;
    this.send({ type: 'UserStartedSpeaking' });
    this.interrupt();
  }

  private onFinal(text: string): void {
    this.userSpeaking = false;
    const said = text.trim();
    if (this.closed || !said || !/[\p{L}\p{N}]/u.test(said)) return;
    this.interrupt();
    this.send({ type: 'ConversationText', role: 'user', content: said });
    void this.runTurn(said);
  }

  /** The caller started talking: stop speaking and thinking about the old turn. */
  private interrupt(): void {
    this.epoch += 1;
    this.abort?.abort();
    this.abort = null;
    for (const resolve of this.pendingFns.values()) resolve(JSON.stringify({ error: 'The caller interrupted.' }));
    this.pendingFns.clear();
    this.carry = Buffer.alloc(0);
  }

  // -------------------------------------------------------------- speaking

  /** Says exactly this text (the opening line or a bridge message). Refused while a turn is in progress. */
  private async inject(text: string): Promise<void> {
    const line = text.trim();
    if (!line || !this.config) return;
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
      if (await queue.finish()) this.send({ type: 'AgentAudioDone' });
    } finally {
      if (epoch === this.epoch) this.turnRunning = false;
      else this.turnRunning = false;
    }
  }

  /** @internal used by SpeechQueue */
  async speakPiece(text: string, epoch: number, signal: AbortSignal, onFirstAudio: () => void): Promise<boolean> {
    const cfg = this.config!;
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
      if (epoch !== this.epoch || this.closed) return any;
      if (!any) {
        any = true;
        onFirstAudio();
      }
      this.sendAudio(chunk);
    }
    return any;
  }

  /** @internal */
  announceSpeaking(): void {
    this.send({ type: 'AgentStartedSpeaking' });
  }

  /** @internal */
  warn(description: string, code: string): void {
    this.send({ type: 'Warning', description, code });
  }

  isCurrent(epoch: number): boolean {
    return !this.closed && epoch === this.epoch;
  }

  // -------------------------------------------------------------- thinking

  private systemPrompt(): string {
    return `${this.config!.prompt}${this.extraPrompt}`.trim();
  }

  private trimHistory(): void {
    while (this.history.length > MAX_HISTORY_MESSAGES) {
      this.history.shift();
      while (this.history.length && (this.history[0].role === 'tool' || (this.history[0].role === 'assistant' && this.history[0].tool_calls))) this.history.shift();
    }
  }

  private async runTurn(userText: string): Promise<void> {
    const cfg = this.config;
    if (!cfg || this.closed) return;
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
        let calls: Array<{ id: string; name: string; arguments: string }> = [];
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
          if (!this.isCurrent(epoch)) return;
          if (ev.type === 'text') {
            text += ev.delta;
            for (const piece of chunker.push(ev.delta)) queue.add(piece);
          } else calls = ev.calls;
        }
        for (const piece of chunker.flush()) queue.add(piece);
        if (!this.isCurrent(epoch)) return;
        if (text.trim()) {
          this.send({ type: 'ConversationText', role: 'assistant', content: text.trim() });
          spoke = true;
        }
        this.history.push({
          role: 'assistant',
          content: text.trim() || null,
          ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.arguments } })) } : {}),
        });
        if (!calls.length) break;
        const results = await this.runFunctions(calls, epoch);
        if (!this.isCurrent(epoch)) return;
        for (const r of results) this.history.push({ role: 'tool', tool_call_id: r.id, content: r.content });
      }
      this.failures = 0;
      if ((await queue.finish()) || spoke) this.send({ type: 'AgentAudioDone' });
    } catch (err: any) {
      if (!this.isCurrent(epoch)) return; // the caller interrupted; nothing to report
      this.failures += 1;
      this.warn(String(err?.message || err).slice(0, 300), 'OWN_LLM');
      if (this.failures >= 3) return this.fail('The language model failed three times in a row.', 'OWN_LLM_FAILED');
      this.history.pop(); // forget the user line that got no answer, so the next try is clean
      const retry = new SpeechQueue(this, epoch, ac.signal);
      retry.add(FALLBACK_LINE);
      this.send({ type: 'ConversationText', role: 'assistant', content: FALLBACK_LINE });
      if (await retry.finish()) this.send({ type: 'AgentAudioDone' });
    } finally {
      if (epoch === this.epoch) this.turnRunning = false;
    }
  }

  private async runFunctions(calls: Array<{ id: string; name: string; arguments: string }>, epoch: number) {
    const waits = calls.map(
      (c) =>
        new Promise<{ id: string; content: string }>((resolve) => {
          const timer = setTimeout(() => {
            this.pendingFns.delete(c.id);
            resolve({ id: c.id, content: JSON.stringify({ error: 'The action took too long.' }) });
          }, FUNCTION_TIMEOUT_MS);
          this.pendingFns.set(c.id, (content) => {
            clearTimeout(timer);
            resolve({ id: c.id, content });
          });
        })
    );
    this.send({
      type: 'FunctionCallRequest',
      functions: calls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments, client_side: true })),
    });
    const out = await Promise.all(waits);
    return this.isCurrent(epoch) ? out : [];
  }
}

/** Speaks pieces in order. Each piece starts synthesising at once, so the next one is ready when the last ends. */
class SpeechQueue {
  private chain: Promise<boolean> = Promise.resolve(false);
  private started = false;

  constructor(private readonly session: OwnAgentSession, private readonly epoch: number, private readonly signal: AbortSignal) {}

  add(text: string): void {
    const prev = this.chain;
    this.chain = (async () => {
      const before = await prev;
      if (!this.session.isCurrent(this.epoch)) return before;
      try {
        const any = await this.session.speakPiece(text, this.epoch, this.signal, () => {
          if (!this.started) {
            this.started = true;
            this.session.announceSpeaking();
          }
        });
        return before || any;
      } catch (err: any) {
        if (this.session.isCurrent(this.epoch)) this.session.warn(`Speaking problem: ${String(err?.message || err).slice(0, 200)}`, 'OWN_TTS');
        return before;
      }
    })();
  }

  /** Resolves when everything queued has been sent. True when any audio went out. */
  finish(): Promise<boolean> {
    return this.chain;
  }
}

// ------------------------------------------------------------------ server

export interface OwnAgentServer {
  /** Address the bridge should connect to, with the one-time secret. */
  url(port: number): string;
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  close(): void;
}

const isLoopback = (addr: string | undefined) => !!addr && (addr === '::1' || addr === '127.0.0.1' || addr === '::ffff:127.0.0.1');

export function createOwnAgentServer(deps: OwnAgentDeps = defaultOwnAgentDeps): OwnAgentServer {
  const token = crypto.randomBytes(24).toString('hex');
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const sessions = new Set<OwnAgentSession>();
  wss.on('connection', (ws) => {
    const s = new OwnAgentSession(ws, deps);
    sessions.add(s);
    ws.on('close', () => sessions.delete(s));
  });
  return {
    url: (port) => `ws://127.0.0.1:${port}${OWN_AGENT_PATH}?token=${token}`,
    handleUpgrade(req, socket, head) {
      const u = new URL(req.url || '/', 'http://local');
      if (u.pathname !== OWN_AGENT_PATH) return false;
      const given = Buffer.from(u.searchParams.get('token') || '');
      const want = Buffer.from(token);
      const ok = isLoopback(req.socket.remoteAddress) && given.length === want.length && crypto.timingSafeEqual(given, want);
      if (!ok) {
        socket.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
        return true;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      return true;
    },
    close() {
      for (const s of sessions) s.close();
      wss.close();
    },
  };
}
