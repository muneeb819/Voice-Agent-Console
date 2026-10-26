export type ProviderKind = 'stt' | 'llm' | 'tts';

export interface Provider {
  id: string;
  kind: ProviderKind;
  name: string;
  type: string;
  models: string; // comma-separated
  endpoint: string;
  headers: string; // JSON object string
  extra: string; // JSON object string
  mk: 'model' | 'model_id';
}

export interface AgentFunction {
  id: string;
  name: string;
  description: string;
  params: string; // JSON schema string
  defer: boolean;
  url: string;
  method: 'post' | 'get';
  headers: string; // JSON object string
}

export interface Agent {
  id: string;
  name: string;
  mode: 'outbound' | 'inbound' | 'both';
  language: string;
  greeting: string;
  prompt: string;
  acceptViciCalls: boolean; // Bridge lifecycle flag (hydrates lead before Deepgram session)
  injectCampaignDisclosure: boolean; // Prepends campaign disclosure to greeting when linked
  stt: {
    p: string;
    model: string;
    keyterms: string;
    eot: number;
    eager: number;
    eotms: number;
    smartFormat: boolean;
  };
  llm: {
    p: string;
    model: string;
    temp: number;
    reasoning: 'low' | 'medium' | 'high';
    ctx: string;
  };
  tts: {
    p: string;
    model: string;
    speed: number;
    expr: number;
  };
  audio: {
    inEnc: 'linear16' | 'mulaw' | 'alaw';
    inRate: number;
    outEnc: 'linear16' | 'mulaw' | 'alaw';
    outRate: number;
  };
  fnIds: string[]; // Immutable function IDs (fixes rename orphan bug)
}

export interface Campaign {
  id: string;
  name: string;
  agentId: string;
  viciCampaign: string;
  lists: string;
  start: string;
  end: string;
  tz: string;
  attempts: number;
  retry: number;
  maxCalls: number;
  xferType: 'ingroup' | 'extension' | 'number';
  xferTarget: string;
  fallback: string;
  dnc: boolean;
  disclosure: string;
  dispos: string;
}

export interface ViciConfig {
  viciBaseUrl: string;
  nonAgentApiPath: string;
  agentApiPath: string;
  apiUser: string;
  source: string;
  transport: 'sip_trunk' | 'audiosocket';
  bridgeHost: string;
  bridgePort: number;
  sipPort: number;
  aiExten: string;
  remoteAgentUser: string;
  inIngroup: string;
  amiHost: string;
  amiPort: number;
  amiUser: string;
}

export interface TestScenario {
  id: string;
  s: string;
  e: string;
  r: 'p' | 'ok' | 'f';
  n: string;
}

export interface ConsoleState {
  version: number;
  updatedAt: string;
  providers: Provider[];
  functions: AgentFunction[];
  agents: Agent[];
  campaigns: Campaign[];
  vici: ViciConfig;
  tests: Record<string, TestScenario[]>;
}

export type ValidationLevel = 'ok' | 'wn' | 'er';

export interface ValidationItem {
  level: ValidationLevel;
  icon: '✓' | '!' | '✗';
  scope: string;
  message: string;
}

export interface DeepgramVoice {
  id: string; // canonical_name e.g. "flux-haley-en" or "aura-2-thalia-en"
  name: string; // short name e.g. "haley"
  displayName: string; // e.g. "Haley"
  family: 'flux-v2' | 'aura-2' | 'aura-1';
  providerVersion: 'v2' | 'v1';
  languages: string[];
  primaryLanguage: string;
  accent: string;
  gender: 'feminine' | 'masculine' | 'neutral';
  age: string;
  tags: string[];
  useCases: string[];
  sampleUrl: string | null;
  avatarUrl: string | null;
  featured: boolean;
}
