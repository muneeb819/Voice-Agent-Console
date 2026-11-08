const baseUrl = process.env.TEST_URL || 'http://localhost:533';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function check(path: string, expectedStatus: number) {
  const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(3000) });
  assert(response.status === expectedStatus, `${path} expected HTTP ${expectedStatus}, received ${response.status}`);
  return { response, body: await response.json() as Record<string, any> };
}

async function run() {
  console.log('=== Health and Readiness Probe Verification ===');
  const live = await check('/health/live', 200);
  assert(live.body.ok === true && live.body.status === 'live', 'liveness must report live');
  assert(live.body.service === 'voice-agent-console', 'liveness must identify service');
  assert(Object.keys(live.body).every((key) => ['ok', 'status', 'service'].includes(key)), 'liveness must expose only its public contract');
  const ready = await check('/health/ready', 200);
  assert(ready.body.ok === true && ready.body.status === 'ready', 'readiness must report ready with local state');
  assert(ready.body.checks?.applicationState === 'ok', 'readiness must confirm local state');
  assert(!('secrets' in ready.body) && !('env' in ready.body), 'readiness must not expose secrets or environment');
  const legacy = await check('/api/health', 200);
  assert(legacy.body.ok === true && legacy.body.service === 'voice-agent-console', 'legacy health endpoint must remain compatible');
  console.log('ALL HEALTH PROBE CHECKS PASSED');
}

run().catch((error) => { console.error('Health verification FAILED:', error); process.exit(1); });
