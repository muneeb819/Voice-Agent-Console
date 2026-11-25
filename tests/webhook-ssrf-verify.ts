import assert from 'assert';
import { executeCustomFunctionWebhook, isBlockedMetadataAddress } from '../src/webhook-executor';

(async () => {
  for (const h of ['169.254.169.254', '[::ffff:169.254.169.254]', '[::ffff:a9fe:a9fe]', '::ffff:a9fe:a9fe', 'fd00:ec2::254', '169.254.0.5', 'metadata.google.internal', '100.100.100.200', 'fe80::1']) {
    assert(isBlockedMetadataAddress(h), `${h} must be blocked`);
  }
  for (const h of ['example.com', '10.0.0.5', '192.168.1.1', '8.8.8.8', '127.0.0.1', '2001:db8::1']) {
    assert(!isBlockedMetadataAddress(h), `${h} must stay allowed`);
  }
  for (const url of ['http://[::ffff:a9fe:a9fe]/latest/meta-data/', 'http://169.254.169.254/latest/meta-data/', 'http://0xa9fea9fe/']) {
    const r = await executeCustomFunctionWebhook({ id: 'f', name: 'f', url, method: 'get' } as any, {}, {});
    assert(r.ok === false && /Blocked cloud metadata/.test(String(r.error)), `${url} must be blocked, got ${r.error}`);
  }
  console.log('✓ webhook SSRF guard: metadata/link-local blocked in every spelling, normal hosts allowed');
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
