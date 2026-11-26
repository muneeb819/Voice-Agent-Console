/**
 * Streaming chat client for any OpenAI-compatible endpoint (OpenAI, Groq, or your own vLLM / Ollama server).
 * It only does the HTTP call and turns the stream into plain events; the conversation logic lives in own-agent.ts.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export interface ChatTool {
  name: string;
  description?: string;
  parameters?: Record<string, any>;
}

export type LlmEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_calls'; calls: Array<{ id: string; name: string; arguments: string }> };

export interface LlmEndpoint {
  baseUrl: string;
  apiKey: string;
}

const KNOWN_BASES: Record<string, { baseUrl: string; keyName: string }> = {
  open_ai: { baseUrl: 'https://api.openai.com/v1', keyName: 'OPENAI_API_KEY' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', keyName: 'GROQ_API_KEY' },
};

/**
 * Where to send chat requests for a provider type. A self-hosted server (OWN_LLM_BASE_URL) wins for every type,
 * so one setting moves the whole console onto your own GPU. Types that do not speak this protocol get a clear error.
 */
export function resolveLlmEndpoint(providerType: string, env: Record<string, string | undefined>): LlmEndpoint {
  const own = String(env.OWN_LLM_BASE_URL || '').trim().replace(/\/+$/, '');
  if (own) return { baseUrl: own, apiKey: String(env.OWN_LLM_API_KEY || '').trim() };
  const known = KNOWN_BASES[providerType];
  if (!known) {
    throw new Error(
      `The own voice engine talks to OpenAI-compatible LLMs only. Choose OpenAI or Groq in Plug-ins, or set OWN_LLM_BASE_URL to your own server (provider "${providerType || 'none'}" is not supported).`
    );
  }
  const apiKey = String(env[known.keyName] || '').trim();
  if (!apiKey) throw new Error(`${known.keyName} is missing. Add it under API Keys.`);
  return { baseUrl: known.baseUrl, apiKey };
}

/** Reads server-sent events and yields each `data:` payload. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
        const data = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (data) yield data;
      }
    }
    const tail = buf.trim();
    if (tail.startsWith('data:')) yield tail.slice(5).trimStart();
  } finally {
    reader.releaseLock();
  }
}

export interface ChatRequest {
  endpoint: LlmEndpoint;
  model: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  temperature?: number;
  reasoningEffort?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

const REASONING_VALUES = new Set(['minimal', 'low', 'medium', 'high']);

export async function* streamChat(req: ChatRequest): AsyncGenerator<LlmEvent> {
  const body: Record<string, any> = { model: req.model, messages: req.messages, stream: true };
  if (req.tools && req.tools.length) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} } },
    }));
  }
  if (req.reasoningEffort && REASONING_VALUES.has(req.reasoningEffort)) body.reasoning_effort = req.reasoningEffort;
  else if (typeof req.temperature === 'number' && Number.isFinite(req.temperature)) body.temperature = req.temperature;

  const res = await (req.fetchImpl || fetch)(`${req.endpoint.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(req.endpoint.apiKey ? { Authorization: `Bearer ${req.endpoint.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: req.signal,
  });
  if (!res.ok || !res.body) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`The language model answered ${res.status}${detail ? `: ${detail}` : ''}`);
  }

  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  for await (const data of readSse(res.body)) {
    if (data === '[DONE]') break;
    let chunk: any;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    const delta = chunk?.choices?.[0]?.delta;
    if (!delta) continue;
    if (typeof delta.content === 'string' && delta.content) yield { type: 'text', delta: delta.content };
    for (const tc of delta.tool_calls || []) {
      const i = Number.isInteger(tc.index) ? tc.index : 0;
      const cur = calls.get(i) || { id: '', name: '', arguments: '' };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.arguments += tc.function.arguments;
      calls.set(i, cur);
    }
  }
  if (calls.size) {
    yield {
      type: 'tool_calls',
      calls: [...calls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([i, c]) => ({ id: c.id || `call_${i}_${Date.now()}`, name: c.name, arguments: c.arguments || '{}' })),
    };
  }
}
