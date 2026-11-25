import assert from 'assert';
import dns from 'dns';
import http from 'http';
import { AddressInfo } from 'net';
import { executeCustomFunctionWebhook, isBlockedMetadataAddress } from '../src/webhook-executor';

const fn = (url: string) => ({ id: 'f', name: 'f', url, method: 'get' }) as any;

(async () => {
  // 1. Address classification in every spelling.
  for (const h of ['169.254.169.254', '[::ffff:169.254.169.254]', '[::ffff:a9fe:a9fe]', '::ffff:a9fe:a9fe', 'fd00:ec2::254', '169.254.0.5', 'metadata.google.internal', '100.100.100.200', 'fe80::1']) {
    assert(isBlockedMetadataAddress(h), `${h} must be blocked`);
  }
  for (const h of ['example.com', '10.0.0.5', '192.168.1.1', '8.8.8.8', '127.0.0.1', '2001:db8::1']) {
    assert(!isBlockedMetadataAddress(h), `${h} must stay allowed`);
  }

  // 2. Literal metadata URLs are refused before any connection.
  for (const url of ['http://[::ffff:a9fe:a9fe]/latest/meta-data/', 'http://169.254.169.254/latest/meta-data/', 'http://0xa9fea9fe/']) {
    const r = await executeCustomFunctionWebhook(fn(url), {}, {});
    assert(r.ok === false && /Blocked cloud metadata/.test(String(r.error)), `${url} must be blocked, got ${r.error}`);
  }

  // 3. DNS rebinding: a name that resolves to the metadata address is refused AT CONNECT TIME.
  const realLookup = dns.lookup;
  (dns as any).lookup = (host: string, opts: any, cb: any) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    if (host === 'rebind.test') {
      return opts && opts.all ? cb(null, [{ address: '169.254.169.254', family: 4 }]) : cb(null, '169.254.169.254', 4);
    }
    return (realLookup as any)(host, opts, cb);
  };
  try {
    const r = await executeCustomFunctionWebhook(fn('http://rebind.test/latest/meta-data/'), {}, {});
    assert(r.ok === false && /Blocked cloud metadata/.test(String(r.error)), `rebinding host must be blocked, got ${r.error}`);
  } finally {
    (dns as any).lookup = realLookup;
  }

  // 4. Normal webhooks still work; redirects, oversize bodies and slow servers fail safely.
  const srv = http.createServer((req, res) => {
    if (req.url?.startsWith('/ok')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ hello: 'world' })); }
    else if (req.url?.startsWith('/redirect')) { res.statusCode = 302; res.setHeader('location', 'http://169.254.169.254/'); res.end(); }
    else if (req.url?.startsWith('/big')) { res.end(Buffer.alloc(200_000, 97)); }
    else if (req.url?.startsWith('/empty')) { res.statusCode = 204; res.end(); }
    else if (req.url?.startsWith('/post')) { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => res.end(JSON.stringify({ got: JSON.parse(b).x }))); }
    /* /hang never answers */
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const ok = await executeCustomFunctionWebhook(fn(`${base}/ok`), {}, {});
    assert(ok.ok && ok.httpStatus === 200 && ok.data?.hello === 'world', `normal webhook must work, got ${JSON.stringify(ok)}`);
    const post = await executeCustomFunctionWebhook({ id: 'f', name: 'f', url: `${base}/post`, method: 'post' } as any, { x: 42 }, {});
    assert(post.ok && post.data?.got === 42, `POST body must arrive, got ${JSON.stringify(post)}`);
    const empty = await executeCustomFunctionWebhook(fn(`${base}/empty`), {}, {});
    assert(empty.ok && empty.httpStatus === 204, `204 must be handled, got ${JSON.stringify(empty)}`);
    const redir = await executeCustomFunctionWebhook(fn(`${base}/redirect`), {}, {});
    assert(!redir.ok && /redirects are not followed/i.test(String(redir.error)), `redirect must not be followed, got ${redir.error}`);
    const big = await executeCustomFunctionWebhook(fn(`${base}/big`), {}, {});
    assert(!big.ok && /exceeds/.test(String(big.error)), `oversize body must be refused, got ${big.error}`);
    const t0 = Date.now();
    const slow = await executeCustomFunctionWebhook(fn(`${base}/hang`), {}, {}, 400);
    assert(!slow.ok && Date.now() - t0 < 3000, `a hung server must time out quickly, took ${Date.now() - t0}ms`);
  } finally {
    srv.closeAllConnections?.();
    await new Promise<void>((r) => srv.close(() => r()));
  }
  console.log('✓ webhook SSRF guard: every spelling blocked, DNS rebinding blocked at connect time, redirects/oversize/timeouts safe, normal calls work');
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
