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

export interface AgentBehavior {
  bargeIn: 'instant' | 'server' | 'off';
  bargeInSensitivity: 'high' | 'balanced' | 'low'; // legacy preset, kept in sync with the percentage
  bargeInSensitivityPct: number; // 0-100: how easily caller sound interrupts the bot (phone + Live Bot)
  latencyProfile: 'ultra' | 'balanced' | 'quality';
  expressionStyle: 'warm_empathetic' | 'energetic_upbeat' | 'charismatic_closer' | 'calm_concierge';
  vocalGestures: boolean;
  allowGeneralQa: boolean;
  selfIntro: string;
  /** Personality, tone and goal in the operator's own words: the only tone guidance the bot gets. */
  speakingStyle?: string;
}

/** How a call starts and flows, set per bot on the front end and saved with the bot. */
export interface AgentFlow {
  waitForHello: boolean;      // stay quiet until the caller speaks first
  waitForHelloSec: number;    // how long to wait before asking if anyone is there (1-10 s)
  noAnswerLine: string;       // e.g. "Hello? Are you there?"
  noAnswerRepeats: number;    // how many times to ask (0-5)
  greetingLines: string;      // one greeting per line, picked at random without repeats
  greetingMaxWords: number;   // longer lines are skipped (5-40)
  introLine: string;          // said after the caller answers the greeting
  transferOnYes: boolean;     // a "yes" to the intro question transfers at once
  repeatLine: string;         // said when the bot did not catch the caller
  defaultSkillsEnabled: boolean; // carry the default skills set (conversation craft, spoken delivery, consistency)
  voiceDeliveryEnabled: boolean; // add the voice-delivery (prosody) guidance to the prompt
  voiceDelivery: string;      // intonation, pace, tone, phrasing, duration, in plain words
}

export interface AgentLinePersona {
  id: string;
  lineNumber: number; // 1-based line slot under this parent agent (e.g. 1..10)
  name: string;       // Persona name spoken on this line (e.g. "Emma", "Chloe")
  voice: string;      // TTS voice ID for this line (e.g. "aura-asteria-en")
  personaStyle?: string; // Optional tone/style hint layered onto parent's System Prompt
  greeting?: string;  // Optional custom opening override for this line
  introLine?: string; // Optional custom intro override for this line
  active: boolean;    // Enable/disable this individual line persona
}

export interface Agent {
  id: string;
  name: string;
  mode: 'outbound' | 'inbound' | 'both';
  language: string;
  greeting: string;
  randomGreetingEnabled: boolean; // Vary one saved opening using a shared-library selection.
  prompt: string;
  acceptViciCalls: boolean; // Bridge lifecycle flag (hydrates lead before Deepgram session)
  injectCampaignDisclosure: boolean; // Prepends campaign disclosure to greeting when linked
  active?: boolean; // Phone switch: an inactive bot takes no phone calls (browser tests still work). Missing = active.
  lines?: number; // Calls this bot may take at once on the phone; 0 or missing = no per-bot limit.
  linePersonas?: AgentLinePersona[]; // 1-to-many sub-personas sharing this agent's master System Prompt
  behavior: AgentBehavior;
  flow?: AgentFlow; // always present after loading (normalizeState fills defaults)
  stt: {
    keyterms: string;
    eot: number;
    eager: number;
    eotms: number;
    smartFormat: boolean;
  };
  llm: {
    temp: number;
    reasoning: 'low' | 'medium' | 'high';
  };
  tts: {
    voice?: string;          // this bot's own voice; empty = use the global voice from Plug-Ins
    speed: number;
    expr: number;
    expressiveness?: number; // self-hosted Chatterbox: emotion intensity (exaggeration), 0.25-2
    variation?: number;      // self-hosted Chatterbox: delivery variation (temperature), 0.3-1.5
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
  agentId: string; // Primary bot for the single telephone route.
  agentIds: string[]; // All bots allowed to use this campaign (browser tests and exports).
  slot: number; // Stable telephone slot: extension = vici.aiExten + slot (never positional).
  viciCampaign: string;
  lists: string;
  start: string;
  end: string;
  tz: string;
  maxCalls: number;
  maxCallsEnabled?: boolean; // The campaign-wide call limit only applies when ticked. Missing = ticked (older data).
  maxCallSec: number; // Hard per-call time limit in seconds (0 = no limit).
  xferType: 'ingroup' | 'extension' | 'number';
  xferTarget: string;
  fallback: string;
  dnc: boolean;
  disclosure: string;
  dispos: string;
  complianceRules: string;
}

export interface ViciConfig {
  viciBaseUrl: string;
  nonAgentApiPath: string;
  agentApiPath: string;
  apiUser: string;
  source: string;
  transport: 'sip_trunk' | 'audiosocket';
  sipConnectionMode: 'static_peer' | 'registration' | 'hybrid';
  sipRegistrarHost: string;
  sipRegistrarPort: number;
  sipDomain: string;
  sipUsername: string;
  sipAuthUsername: string;
  sipTransportProtocol: 'udp';
  bridgeHost: string;
  bridgePort: number;
  sipPort: number;
  aiExten: string;
  remoteAgentUser: string;
  inIngroup: string;
  amiHost: string;
  amiPort: number;
  amiUser: string;
  /** Backup transfer: if the Agent API and AMI both fail, ask the dialer to transfer the call over SIP (REFER). */
  sipReferFallback: boolean;
}

export interface TestScenario {
  id: string;
  s: string;
  e: string;
  r: 'p' | 'ok' | 'f';
  n: string;
}

export interface GlobalServiceSelection {
  providerId: string;
  model: string;
}

export interface ConsoleState {
  version: number;
  updatedAt: string;
  services: {
    stt: GlobalServiceSelection;
    llm: GlobalServiceSelection;
    tts: GlobalServiceSelection;
  };
  providers: Provider[];
  functions: AgentFunction[];
  agents: Agent[];
  campaigns: Campaign[];
  vici: ViciConfig;
  tests: Record<string, TestScenario[]>;
  campaignSlotSeq: number; // Highest campaign telephone slot ever issued (never decreases).
  seededBuiltins: string[]; // Built-in bots already offered to this install (added once, never re-added after a delete).
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
