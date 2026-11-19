import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { createDefaultState, normalizeState } from '../src/defaults';
import { interpolateProviderPlaceholders } from '../src/env-store';
import { validateState } from '../src/settings-builder';
import { SipRegistrationClient } from '../src/vici-sip-registration';
import { ViciConfig } from '../src/types';

const TEST_PASSWORD = 'sip-test-password-123';
const TEST_USER = '1001';
const BRIDGE_HOST = '203.0.113.10';

function baseConfig(port: number, overrides: Partial<ViciConfig> = {}): ViciConfig {
  const state = normalizeState(createDefaultState());
  return {
    ...state.vici,
    sipConnectionMode: 'registration',
    sipRegistrarHost: '127.0.0.1',
    sipRegistrarPort: port,
    sipDomain: 'pbx.example.test',
    sipUsername: TEST_USER,
    sipAuthUsername: TEST_USER,
    sipTransportProtocol: 'udp',
    bridgeHost: BRIDGE_HOST,
    sipPort: 5062,
    ...overrides,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for SIP registration state');
}

async function bindMock(): Promise<{ socket: dgram.Socket; port: number }> {
  const socket = dgram.createSocket('udp4');
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', () => resolve());
  });
  const address = socket.address();
  assert.equal(typeof address, 'object');
  return { socket, port: (address as dgram.AddressInfo).port };
}

async function closeSocket(socket: dgram.Socket): Promise<void> {
  await new Promise<void>((resolve) => socket.close(() => resolve()));
}

async function main() {
  process.env.VICI_SIP_PASSWORD = TEST_PASSWORD;

  // A successful challenge/response cycle: 401 with qop=auth, then authenticated
  // REGISTER with a masked password, followed by 200 + Expires and a clean stop.
  const mock = await bindMock();
  const requests: string[] = [];
  let challengeSent = false;
  mock.socket.on('message', (message, peer) => {
    const text = message.toString('utf8');
    if (!text.startsWith('REGISTER ')) return;
    requests.push(text);
    assert.ok(!text.includes(TEST_PASSWORD), 'the SIP password must never appear in a REGISTER request');
    if (!challengeSent) {
      challengeSent = true;
      const challenge = [
        'SIP/2.0 401 Unauthorized',
        'WWW-Authenticate: Digest realm="pbx.example.test", nonce="abc123", qop="auth", algorithm=MD5',
        'Content-Length: 0',
        '',
        '',
      ].join('\r\n');
      mock.socket.send(Buffer.from(challenge), peer.port, peer.address);
      return;
    }
    assert.match(text, /^Authorization: Digest username="1001"/m);
    assert.match(text, /qop=auth/);
    assert.match(text, /uri="sip:pbx\.example\.test"/);
    const unregister = /^Expires: 0$/m.test(text);
    assert.match(text, unregister ? /nc=00000002/ : /nc=00000001/);
    const ok = ['SIP/2.0 200 OK', unregister ? 'Expires: 0' : 'Expires: 120', 'Content-Length: 0', '', ''].join('\r\n');
    mock.socket.send(Buffer.from(ok), peer.port, peer.address);
  });

  const client = new SipRegistrationClient(baseConfig(mock.port));
  await client.start();
  await waitFor(() => client.snapshot().status === 'registered');
  const registered = client.snapshot();
  assert.equal(requests.length, 2);
  assert.ok(registered.expiresAt, 'a registered client must expose an expiry');
  assert.equal(registered.lastError, null);
  await client.stop();
  assert.equal(client.snapshot().status, 'stopped');
  assert.equal(client.snapshot().expiresAt, null);
  await closeSocket(mock.socket);
  console.log('✓ SIP REGISTER digest challenge, authenticated refresh and unregister lifecycle');

  // Unsupported digest algorithms must fail closed, not downgrade.
  const unsupported = await bindMock();
  unsupported.socket.once('message', (_message, peer) => {
    const challenge = [
      'SIP/2.0 401 Unauthorized',
      'WWW-Authenticate: Digest realm="pbx.example.test", nonce="abc", qop="auth", algorithm=SHA-256',
      'Content-Length: 0',
      '',
      '',
    ].join('\r\n');
    unsupported.socket.send(Buffer.from(challenge), peer.port, peer.address);
  });
  const unsupportedClient = new SipRegistrationClient(baseConfig(unsupported.port));
  await unsupportedClient.start();
  await waitFor(() => unsupportedClient.snapshot().status === 'failed');
  assert.match(unsupportedClient.snapshot().lastError || '', /unsupported/i);
  await unsupportedClient.stop();
  await closeSocket(unsupported.socket);
  console.log('✓ Unsupported SIP digest algorithms fail closed');

  // Repeated 401s must stop after a bounded number of attempts instead of
  // looping forever against the registrar.
  const retryMock = await bindMock();
  let retryRequests = 0;
  retryMock.socket.on('message', (message, peer) => {
    const text = message.toString('utf8');
    if (!text.startsWith('REGISTER ')) return;
    retryRequests += 1;
    const challenge = [
      'SIP/2.0 401 Unauthorized',
      `WWW-Authenticate: Digest realm="pbx.example.test", nonce="nonce-${retryRequests}", qop="auth", algorithm=MD5`,
      'Content-Length: 0',
      '',
      '',
    ].join('\r\n');
    retryMock.socket.send(Buffer.from(challenge), peer.port, peer.address);
  });
  const retryClient = new SipRegistrationClient(baseConfig(retryMock.port));
  await retryClient.start();
  await waitFor(() => retryClient.snapshot().status === 'failed');
  assert.equal(retryRequests, 3, 'the client must stop after two re-authentication attempts');
  assert.match(retryClient.snapshot().lastError || '', /rejected.*repeatedly/i);
  await retryClient.stop();
  await closeSocket(retryMock.socket);
  console.log('✓ Repeated 401 challenges fail closed after a bounded retry count');

  // A loopback/unspecified Contact is not reachable by a registrar and must be
  // rejected instead of registering an unusable address.
  const loopback = new SipRegistrationClient(baseConfig(5060, { bridgeHost: '127.0.0.1' }));
  await loopback.start();
  assert.equal(loopback.snapshot().status, 'failed');
  assert.match(loopback.snapshot().lastError || '', /public\/reachable Bridge Host/i);

  // Direct constructor input with CRLF must never reach a raw SIP header.
  const injected = new SipRegistrationClient(baseConfig(5060, {
    sipUsername: `${TEST_USER}\r\nX-Injected: yes`,
    bridgeHost: BRIDGE_HOST,
  }));
  await injected.start();
  assert.equal(injected.snapshot().status, 'failed');
  assert.match(injected.snapshot().lastError || '', /unsafe header/i);
  console.log('✓ Loopback Contact and SIP header-injection inputs are rejected');

  // normalizeState strips control/header characters from imported state.
  const state = normalizeState({
    ...createDefaultState(),
    vici: {
      ...createDefaultState().vici,
      sipRegistrarHost: 'pbx.example.test\r\nX-Injected: yes',
      sipDomain: 'pbx"example.test',
      sipUsername: `${TEST_USER}\r\nX-Injected: yes`,
      sipAuthUsername: 'auth user',
      bridgeHost: '203.0.113.10\r\nX-Injected: yes',
    },
  });
  assert.equal(state.vici.sipRegistrarHost, 'pbx.example.testX-Injected:yes');
  assert.equal(state.vici.sipDomain, 'pbxexample.test');
  assert.equal(state.vici.sipUsername, `${TEST_USER}X-Injectedyes`);
  assert.equal(state.vici.sipAuthUsername, 'authuser');
  assert.equal(state.vici.bridgeHost, '203.0.113.10X-Injected:yes');
  for (const value of [state.vici.sipRegistrarHost, state.vici.sipDomain, state.vici.sipUsername, state.vici.sipAuthUsername, state.vici.bridgeHost]) {
    assert.ok(!/[\r\n\0"<>]/.test(value), `unsanitized SIP value: ${value}`);
  }
  console.log('✓ Imported SIP configuration is stripped of header/control characters');

  // Deployment preflight must surface registration misconfiguration instead of
  // letting the bridge start with an unusable Contact.
  const ready = normalizeState({
    ...createDefaultState(),
    vici: {
      ...createDefaultState().vici,
      sipConnectionMode: 'registration',
      sipRegistrarHost: 'pbx.example.test',
      sipUsername: TEST_USER,
      bridgeHost: BRIDGE_HOST,
    },
  });
  const readySip = validateState(ready).filter((item) => item.scope === 'VICIdial SIP');
  assert.ok(readySip.length > 0);
  assert.ok(readySip.every((item) => item.level === 'ok'), JSON.stringify(readySip));

  const badSip = validateState(normalizeState({
    ...createDefaultState(),
    vici: {
      ...createDefaultState().vici,
      sipConnectionMode: 'registration',
      sipRegistrarHost: '',
      sipUsername: '',
      bridgeHost: '127.0.0.1',
    },
  })).filter((item) => item.scope === 'VICIdial SIP');
  assert.ok(badSip.some((item) => item.level === 'er' && /registrar host/i.test(item.message)));
  assert.ok(badSip.some((item) => item.level === 'er' && /public\/reachable/i.test(item.message)));
  for (const unspecified of ['0.0.0.0', '::', '[::]']) {
    const preflight = validateState(normalizeState({
      ...createDefaultState(),
      vici: {
        ...createDefaultState().vici,
        sipConnectionMode: 'registration',
        sipRegistrarHost: 'pbx.example.test',
        sipUsername: TEST_USER,
        bridgeHost: unspecified,
      },
    })).filter((item) => item.scope === 'VICIdial SIP');
    assert.ok(preflight.some((item) => item.level === 'er' && /public\/reachable/i.test(item.message)), `preflight accepted ${unspecified}`);
  }
  console.log('✓ SIP deployment preflight rejects missing registrar and loopback Contact');

  // The SIP password must not be reachable through provider configuration.
  const provider = interpolateProviderPlaceholders({
    prompt: '{{VICI_SIP_PASSWORD}}',
    endpoint: '{{VICI_SIP_PASSWORD}}',
  });
  assert.deepEqual(provider, { prompt: '', endpoint: '' });
  console.log('✓ VICI_SIP_PASSWORD is excluded from provider placeholder interpolation');
}

main().catch((error) => {
  console.error('SIP registration verification FAILED:', error);
  process.exitCode = 1;
});
