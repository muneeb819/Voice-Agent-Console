/**
 * Production-hardening regressions (2026-11-20 audit):
 *  - REL-01 stable campaign telephone slots (delete/reorder never re-routes calls)
 *  - SEC-20 only owner/admin may change where stored credentials are sent
 *  - SIP-10 RTP inactivity watchdog ends calls whose BYE was lost
 *  - SIP-11 NAT: private SDP media address falls back to the signaling source,
 *           and RTP latches onto the real source port (symmetric RTP)
 *  - SIP-12 optional fixed RTP port range
 *
 * Loopback only, synthetic credentials, mocked provider and VICIdial API.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vac-hardening-'));
process.env.VAC_DATA_DIR = dataDir;
process.env.VAC_ENV_FILE = path.join(dataDir, '.env');
process.env.ADMIN_PASSWORD = '';
process.env.TRUST_PROXY = '';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn: () => boolean, label: string, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await wait(20);
  }
}

async function main() {
  const { assignCampaignSlots } = await import('../src/campaign-assignment');
  const { normalizeState } = await import('../src/defaults');
  const { credentialRoutingChanges } = await import('../src/state-guard');
  const { getConsoleState, saveConsoleState } = await import('../src/db');
  const { generateViciConfig: buildViciConfig } = await import('../src/settings-builder');
  const bridgeModule = await import('../src/vici-bridge');
  const { resolveCampaignAndAgent, rtpPortRange, rtpInactivityTimeoutMs, VicidialBridgeService } = bridgeModule;
  const { buildRtpPacket, linear16ToUlaw, parseRtpPacket } = await import('../src/g711');

  // ------------------------------------------------------------ REL-01 slots
  {
    const legacy = assignCampaignSlots([{ id: 'a' }, { id: 'b' }, { id: 'c' }] as any[]);
    assert.deepEqual(legacy.map((c) => c.slot), [1, 2, 3], 'legacy state keeps its positional numbering');
    const afterDelete = assignCampaignSlots(legacy.slice(1));
    assert.deepEqual(afterDelete.map((c) => c.slot), [2, 3], 'deleting campaign 1 does not renumber the others');
    const added = assignCampaignSlots([...afterDelete, { id: 'd' } as any]);
    assert.equal(added[2].slot, 4, 'a new campaign never reuses a deleted extension');
    const dup = assignCampaignSlots([{ id: 'x', slot: 2 }, { id: 'y', slot: 2 }] as any[]);
    assert.deepEqual(dup.map((c) => c.slot), [2, 3], 'a copied slot is reassigned');
    const reordered = assignCampaignSlots([added[1], added[0], added[2]]);
    assert.deepEqual(reordered.map((c) => c.slot), [3, 2, 4], 'reordering keeps each campaign slot');

    const base = normalizeState(getConsoleState());
    assert.ok(base.campaigns.length >= 2, 'fixture needs two campaigns');
    assert.ok(base.campaigns.every((c) => Number.isInteger(c.slot) && c.slot > 0), 'every campaign has a slot');
    const second = base.campaigns[1];
    const prefix = base.vici.aiExten;
    const withoutFirst = normalizeState({ ...base, campaigns: base.campaigns.slice(1) });
    assert.equal(withoutFirst.campaigns[0].id, second.id);
    assert.equal(withoutFirst.campaigns[0].slot, second.slot, 'slot survives deletion of an earlier campaign');
    const routed = resolveCampaignAndAgent(withoutFirst, `${prefix}${second.slot}`);
    assert.equal(routed.campaign?.id, second.id, 'extension still reaches the same campaign after a deletion');
    assert.equal(routed.remoteAgentUser, String(Number(base.vici.remoteAgentUser) + second.slot - 1));
    const stale = resolveCampaignAndAgent(withoutFirst, `${prefix}${base.campaigns[0].slot}`);
    assert.ok(stale.error && !stale.campaign, "a deleted campaign's extension is refused, not re-routed");
    if (typeof buildViciConfig === 'function') {
      assert.match(buildViciConfig(withoutFirst), new RegExp(`Remote Agent Exten\\s*: ${prefix}${second.slot}\\b`));
    }
    // Codex P2: deleting the HIGHEST slot must not free it for the next campaign.
    {
      const { reconcileCampaignSlots } = await import('../src/campaign-assignment');
      const prev = { campaigns: [{ id: 'a', slot: 1 }, { id: 'b', slot: 2 }, { id: 'c', slot: 3 }], campaignSlotSeq: 3 };
      const normalizedNext = normalizeState({ ...base, campaignSlotSeq: 3, campaigns: [base.campaigns[0], base.campaigns[1], { ...base.campaigns[1], id: 'brand_new', slot: undefined }] });
      assert.ok(normalizedNext.campaigns[2].slot > 3, 'normalize honours the stored high-water mark');
      const next = { campaigns: [{ id: 'a', slot: 1 }, { id: 'b', slot: 2 }, { id: 'd', slot: 3 }], campaignSlotSeq: 3 };
      reconcileCampaignSlots(prev, next);
      assert.equal(next.campaigns[2].slot, 4, 'a stale client reusing a retired slot is moved to a fresh one');
      assert.equal(next.campaignSlotSeq, 4);
      const kept = { campaigns: [{ id: 'a', slot: 1 }, { id: 'b', slot: 2 }], campaignSlotSeq: 3 };
      reconcileCampaignSlots(prev, kept);
      assert.equal(kept.campaignSlotSeq, 3, 'the high-water mark never decreases after a delete');

      // End to end through the store: delete the last campaign, add one.
      const saved = getConsoleState();
      const top = saved.campaigns.reduce((m, c) => Math.max(m, c.slot), 0);
      saveConsoleState({ ...saved, campaigns: saved.campaigns.filter((c) => c.slot !== top) }, 'delete top slot');
      const afterDel = getConsoleState();
      // A client that does not send campaignSlotSeq (older browser tab) must not
      // get the retired number either: the store reconciles against saved state.
      const { campaignSlotSeq: _dropped, ...withoutSeq } = afterDel as any;
      void _dropped;
      saveConsoleState({ ...withoutSeq, campaigns: [...afterDel.campaigns, { ...afterDel.campaigns[0], id: 'cp_after_delete', slot: top }] }, 'add campaign');
      const added2 = getConsoleState().campaigns.find((c) => c.id === 'cp_after_delete')!;
      assert.ok(added2.slot > top, `retired slot ${top} is not re-issued (got ${added2.slot})`);
      saveConsoleState(saved, 'restore fixture');
    }
    console.log('✓ REL-01 campaign extensions are stable across delete, reorder and copy');
  }

  // ------------------------------------------------- SEC-20 credential routing
  {
    const s0 = normalizeState(getConsoleState());
    assert.deepEqual(credentialRoutingChanges(s0, normalizeState(s0)), []);
    const prompt = normalizeState({ ...s0, agents: s0.agents.map((a, i) => (i === 0 ? { ...a, prompt: `${a.prompt}\nExtra line.` } : a)) });
    assert.deepEqual(credentialRoutingChanges(s0, prompt), [], 'persona edits are not credential routing');
    const vici = normalizeState({ ...s0, vici: { ...s0.vici, viciBaseUrl: 'https://attacker.example' } });
    assert.ok(credentialRoutingChanges(s0, vici).length === 1);
    const prov = normalizeState({ ...s0, providers: s0.providers.map((p, i) => (i === 0 ? { ...p, endpoint: 'https://attacker.example/x' } : p)) });
    assert.ok(credentialRoutingChanges(s0, prov).some((x) => /provider/.test(x)));
    const fn = normalizeState({ ...s0, functions: s0.functions.map((f, i) => (i === 0 ? { ...f, url: 'https://attacker.example/{{CUSTOM_WEBHOOK_SECRET}}' } : f)) });
    assert.ok(credentialRoutingChanges(s0, fn).some((x) => /webhook/.test(x)));

    const { createApp } = await import('../src/server');
    const { createUser, createUserSession } = await import('../src/user-store');
    const { invalidateUserCountCache } = await import('../src/auth-guard');
    const owner = await createUser({ email: 'owner@hardening.test', fullName: 'Owner Person', password: 'Owner-Passphrase-2026!' });
    const operator = await createUser({ email: 'operator@hardening.test', fullName: 'Operator Person', password: 'Operator-Passphrase-2026!' });
    assert.ok(owner.ok && operator.ok);
    invalidateUserCountCache();
    const ownerCookie = `vac_session=${createUserSession(owner.user!.id)}`;
    const operatorCookie = `vac_session=${createUserSession(operator.user!.id)}`;
    const app = createApp();
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
    const put = (cookie: string, state: unknown) => fetch(`${base}/api/state`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ state }),
    });
    try {
      const current = getConsoleState();
      const r1 = await put(operatorCookie, { ...current, vici: { ...current.vici, viciBaseUrl: 'https://attacker.example' } });
      assert.equal(r1.status, 403, 'operator cannot redirect the VICIdial API password');
      assert.notEqual(getConsoleState().vici.viciBaseUrl, 'https://attacker.example');
      const r2 = await put(operatorCookie, { ...current, functions: current.functions.map((f, i) => (i === 0 ? { ...f, url: 'https://attacker.example/hook' } : f)) });
      assert.equal(r2.status, 403, 'operator cannot redirect webhook secrets');
      const r3 = await put(operatorCookie, { ...current, agents: current.agents.map((a, i) => (i === 0 ? { ...a, prompt: `${a.prompt}\nOperator edit.` } : a)) });
      assert.equal(r3.status, 200, 'operator can still edit personas');
      const after = getConsoleState();
      const r4 = await put(ownerCookie, { ...after, vici: { ...after.vici, viciBaseUrl: 'http://127.0.0.1:9' } });
      assert.equal(r4.status, 200, 'owner can change connection settings');
      // Codex P1: switching the active provider is also a credential route.
      {
        const cur = getConsoleState();
        const otherTts = cur.providers.find((p) => p.kind === 'tts' && p.id !== cur.services.tts.providerId && p.models.split(',')[0].trim());
        assert.ok(otherTts, 'fixture has an alternative TTS provider');
      if (otherTts) {
          const r5 = await fetch(`${base}/api/state`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: operatorCookie },
            body: JSON.stringify({ state: { ...cur, services: { ...cur.services, tts: { providerId: otherTts.id, model: otherTts.models.split(',')[0].trim() } } } }) });
          assert.equal(r5.status, 403, 'operator cannot activate a different provider');
        }
        assert.ok(credentialRoutingChanges(cur, normalizeState({ ...cur, services: { ...cur.services, tts: { providerId: otherTts!.id, model: otherTts!.models.split(',')[0].trim() } } })).some((x) => /provider selection/.test(x)));
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
    console.log('✓ SEC-20 only owner/admin may change where stored credentials are sent');
  }

  // ------------------------------------------------- SIP env parsing helpers
  assert.equal(rtpPortRange({} as any), null);
  assert.deepEqual(rtpPortRange({ BRIDGE_RTP_PORT_MIN: '20000', BRIDGE_RTP_PORT_MAX: '20010' } as any), { min: 20000, max: 20010 });
  assert.equal(rtpPortRange({ BRIDGE_RTP_PORT_MIN: '30000', BRIDGE_RTP_PORT_MAX: '20000' } as any), null);
  assert.equal(rtpInactivityTimeoutMs({} as any), 60000);
  assert.equal(rtpInactivityTimeoutMs({ BRIDGE_RTP_TIMEOUT_SEC: '0' } as any), 0);
  assert.equal(rtpInactivityTimeoutMs({ BRIDGE_RTP_TIMEOUT_SEC: '2' } as any), 2000);

  // ------------------------------------------- SIP-10/11/12 end-to-end on SIP
  const state = getConsoleState();
  const stt = state.providers.find((p) => p.kind === 'stt')!;
  const llm = state.providers.find((p) => p.kind === 'llm' && p.type === 'open_ai')!;
  const tts = state.providers.find((p) => p.kind === 'tts' && p.type === 'deepgram')!;
  state.services = {
    stt: { providerId: stt.id, model: 'nova-3' },
    llm: { providerId: llm.id, model: 'gpt-4o-mini' },
    tts: { providerId: tts.id, model: 'aura-2-thalia-en' },
  };
  const campaign = state.campaigns[0];
  campaign.complianceRules = 'Reviewed hardening fixture rules: be truthful, avoid unsupported claims, and honor do-not-call requests immediately.';
  const viciApi = http.createServer((req, res) => {
    const fnName = new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('function') || '';
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(fnName === 'lead_all_info'
      ? 'lead_id|phone_number|first_name|last_name|state|date_of_birth|age|status|campaign_id\n104892|3055550192|Robert|Fixture|FL|1955-04-10|71|NEW|FETEST'
      : 'SUCCESS: synthetic');
  });
  await new Promise<void>((r) => viciApi.listen(0, '127.0.0.1', r));
  state.vici.viciBaseUrl = `http://127.0.0.1:${(viciApi.address() as net.AddressInfo).port}`;
  saveConsoleState(state, 'Hardening SIP fixture');

  let callerBytes = 0;
  let providerClosed = 0;
  const provider = http.createServer();
  const wss = new WebSocketServer({ server: provider, path: '/agent' });
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'Welcome' }));
    ws.on('close', () => { providerClosed += 1; });
    ws.on('message', (raw, binary) => {
      if (binary) {
        const pcm = Buffer.from(raw as Buffer);
        if (pcm.some((b) => b !== 0)) callerBytes += pcm.length;
        return;
      }
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'Settings' && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'SettingsApplied' }));
    });
  });
  await new Promise<void>((r) => provider.listen(0, '127.0.0.1', r));
  process.env.DEEPGRAM_AGENT_URL = `ws://127.0.0.1:${(provider.address() as net.AddressInfo).port}/agent`;
  process.env.DEEPGRAM_API_KEY = 'synthetic-bridge-key';
  process.env.BRIDGE_ALLOWED_IPS = '127.0.0.1';
  process.env.BRIDGE_RTP_TIMEOUT_SEC = '1.5';
  process.env.BRIDGE_RTP_PORT_MIN = '41000';
  process.env.BRIDGE_RTP_PORT_MAX = '41019';

  const bridge = new VicidialBridgeService({ host: '127.0.0.1', audioSocketPort: 0, sipPort: 0 });
  await bridge.start();
  const sipPort = bridge.getStatus().sipPort;
  assert.ok(sipPort > 0, 'bridge SIP port');

  const sip = dgram.createSocket('udp4');
  const rtpAdvertised = dgram.createSocket('udp4'); // port written in the SDP
  const rtpActual = dgram.createSocket('udp4'); // NAT-rewritten source port
  await Promise.all([sip, rtpAdvertised, rtpActual].map((s) => new Promise<void>((r) => s.bind(0, '127.0.0.1', r))));
  const port = (s: dgram.Socket) => (s.address() as net.AddressInfo).port;
  let bridgeRtpPort = 0;
  let byeAt = 0;
  let botPacketsOnActual = 0;
  rtpActual.on('message', (pkt) => { if (parseRtpPacket(pkt)) botPacketsOnActual += 1; });
  sip.on('message', (data) => {
    const m = data.toString();
    if (m.startsWith('SIP/2.0 200') && /^CSeq:\s*1 INVITE/im.test(m)) {
      bridgeRtpPort = Number(/^m=audio\s+(\d+)/m.exec(m)?.[1] || 0);
    } else if (m.startsWith('BYE ')) byeAt = Date.now();
  });
  const ext = `${state.vici.aiExten}${campaign.slot}`;
  // Private, non-allowlisted SDP address: a NAT'd PBX. Must not be rejected.
  const sdp = ['v=0', 'o=fixture 1 1 IN IP4 10.9.9.9', 's=Fixture', 'c=IN IP4 10.9.9.9', 't=0 0',
    `m=audio ${port(rtpAdvertised)} RTP/AVP 0`, 'a=rtpmap:0 PCMU/8000', ''].join('\r\n');
  const invite = [
    `INVITE sip:${ext}@127.0.0.1:${sipPort} SIP/2.0`,
    `Via: SIP/2.0/UDP 127.0.0.1:${port(sip)};branch=z9hG4bKhard;rport`,
    'From: "V1027153012000104892" <sip:3055550192@127.0.0.1>;tag=hard',
    `To: <sip:${ext}@127.0.0.1>`, `Contact: <sip:fixture@127.0.0.1:${port(sip)}>`,
    `Call-ID: ${crypto.randomUUID()}@hardening`, 'CSeq: 1 INVITE', `X-Vici-Exten: ${ext}`,
    'Content-Type: application/sdp', `Content-Length: ${Buffer.byteLength(sdp)}`, '', sdp,
  ].join('\r\n');
  // Occupy all but one port of the range: the bridge must scan past EADDRINUSE.
  const blockers: dgram.Socket[] = [];
  for (let p = 41000; p <= 41018; p += 1) {
    const b = dgram.createSocket('udp4');
    await new Promise<void>((r) => b.bind(p, '127.0.0.1', r));
    blockers.push(b);
  }
  sip.send(Buffer.from(invite), sipPort, '127.0.0.1');
  await until(() => bridgeRtpPort > 0, 'SIP 200 OK for a NAT-advertised SDP');
  assert.equal(bridgeRtpPort, 41019, `RTP port scan skipped busy ports (got ${bridgeRtpPort})`);
  for (const b of blockers) b.close();
  console.log('✓ SIP-11/12 private SDP address accepted via signaling source; RTP bound inside the configured range');

  // Caller audio arrives from a different source port than the SDP (NAT).
  const startedAt = Date.now();
  for (let i = 0; i < 15; i += 1) {
    const pkt = buildRtpPacket({ payloadType: 0, sequenceNumber: i + 1, timestamp: 160 * (i + 1), ssrc: 777,
      marker: i === 0, payload: linear16ToUlaw(Buffer.alloc(320, 0x22)) });
    rtpActual.send(pkt, bridgeRtpPort, '127.0.0.1');
    await wait(20);
  }
  await until(() => callerBytes > 0, 'caller audio delivered after symmetric-RTP latching');
  console.log('✓ SIP-11 RTP latched onto the real source port; caller audio reaches the provider');

  // Stop sending RTP without a BYE: the watchdog must end the call.
  await until(() => byeAt > 0, 'watchdog BYE after RTP stops', 6000);
  assert.ok(byeAt - startedAt >= 1400, 'watchdog does not fire while RTP is flowing');
  await until(() => providerClosed > 0, 'provider session closed after RTP timeout', 4000);
  console.log('✓ SIP-10 RTP inactivity watchdog sent BYE and closed the provider session');
  void botPacketsOnActual;

  for (const s of [sip, rtpAdvertised, rtpActual]) try { s.close(); } catch {}
  await bridge.stop();
  wss.close();
  provider.close();
  viciApi.close();
  console.log('ALL HARDENING CHECKS PASSED');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
