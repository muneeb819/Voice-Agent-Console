import type { ConsoleState } from './types';

/**
 * Fields that decide WHERE the server sends stored credentials.
 *
 * The server attaches VICI_API_PASS to vici.viciBaseUrl, AMI_SECRET to
 * vici.amiHost, VICI_SIP_PASSWORD to the SIP registrar, provider API keys to
 * provider endpoints/headers/extra ({{OPENAI_API_KEY}} etc.) and
 * CUSTOM_WEBHOOK_SECRET to function webhook URLs/headers. Any account that can
 * change these destinations can make the server deliver those secrets to a host
 * it controls, so only owner/admin accounts may change them. Operators and QA
 * keep full control of personas, prompts, campaigns and tests.
 */
function credentialRoutingProjection(state: ConsoleState) {
  const v = state.vici;
  const byId = <T extends { id: string }>(items: T[]) => [...items].sort((a, b) => a.id.localeCompare(b.id));
  return {
    // Selecting a different provider activates its endpoint/headers (and the
    // API keys interpolated into them), so the selection is a route too.
    services: {
      stt: state.services.stt.providerId,
      llm: state.services.llm.providerId,
      tts: state.services.tts.providerId,
    },
    vici: {
      viciBaseUrl: v.viciBaseUrl,
      nonAgentApiPath: v.nonAgentApiPath,
      agentApiPath: v.agentApiPath,
      apiUser: v.apiUser,
      amiHost: v.amiHost,
      amiPort: v.amiPort,
      amiUser: v.amiUser,
      sipConnectionMode: v.sipConnectionMode,
      sipRegistrarHost: v.sipRegistrarHost,
      sipRegistrarPort: v.sipRegistrarPort,
      sipDomain: v.sipDomain,
      sipUsername: v.sipUsername,
      sipAuthUsername: v.sipAuthUsername,
    },
    providers: byId(state.providers).map((p) => ({ id: p.id, type: p.type, endpoint: p.endpoint, headers: p.headers, extra: p.extra })),
    functions: byId(state.functions).map((f) => ({ id: f.id, url: f.url, method: f.method, headers: f.headers })),
  };
}

/** Returns the credential-routing areas that differ between two normalized states. */
export function credentialRoutingChanges(prev: ConsoleState, next: ConsoleState): string[] {
  const a = credentialRoutingProjection(prev);
  const b = credentialRoutingProjection(next);
  const changed: string[] = [];
  if (JSON.stringify(a.services) !== JSON.stringify(b.services)) changed.push('active STT/LLM/TTS provider selection');
  if (JSON.stringify(a.vici) !== JSON.stringify(b.vici)) changed.push('VICIdial/AMI/SIP connection settings');
  if (JSON.stringify(a.providers) !== JSON.stringify(b.providers)) changed.push('provider endpoints, headers or extra settings');
  if (JSON.stringify(a.functions) !== JSON.stringify(b.functions)) changed.push('function webhook URLs, methods or headers');
  return changed;
}
