// Preloaded only by the isolated test runner. Prevent built-in fetch from
// reaching external services unless the operator explicitly opts in.
const net = require('net');
const originalFetch = globalThis.fetch;
globalThis.fetch = function (input, init) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const isLocal = host === 'localhost' || host === '::1' || (net.isIP(host) === 4 && host.startsWith('127.'));
  if (!isLocal) return Promise.reject(new Error('External fetch disabled by offline test runner'));
  return originalFetch.call(this, input, init);
};
