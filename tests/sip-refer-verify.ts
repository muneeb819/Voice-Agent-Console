import { buildReferRequest, parseCseqHeader, parseSipResponseLine, ReferTracker, referOutcome, sanitizeReferTarget } from '../src/sip-refer';

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const base = {
  remoteContactUri: 'sip:asterisk@5.9.21.61:5060',
  localHost: '54.79.152.235',
  localPort: 5062,
  fromHeader: '<sip:88003@54.79.152.235>;tag=abc',
  toHeader: '"RINGAGENT00005840668" <sip:asterisk@5.9.21.61>;tag=xyz',
  callId: 'call-1@5.9.21.61',
  cseq: 2,
  contactUser: '88003',
  target: '8200',
  referHost: '5.9.21.61',
};

async function main() {
  // Target validation
  assert(sanitizeReferTarget('8200') === '8200', 'plain extension accepted');
  assert(sanitizeReferTarget(' 8200 ') === '8200', 'whitespace trimmed');
  assert(sanitizeReferTarget('8200\r\nX-Evil: 1') === null, 'header injection rejected');
  assert(sanitizeReferTarget('') === null, 'empty rejected');
  assert(sanitizeReferTarget('a@b;c') === null, 'URI separators rejected');

  // Message shape
  const { message } = buildReferRequest(base);
  assert(message.startsWith('REFER sip:asterisk@5.9.21.61:5060 SIP/2.0\r\n'), 'request line');
  assert(message.includes('CSeq: 2 REFER\r\n'), 'cseq');
  assert(message.includes('Refer-To: <sip:8200@5.9.21.61>\r\n'), 'refer-to');
  assert(message.includes('Call-ID: call-1@5.9.21.61\r\n'), 'call-id');
  assert(message.endsWith('Content-Length: 0\r\n\r\n'), 'terminated');
  let threw = false;
  try { buildReferRequest({ ...base, target: '8200\r\nX: y' }); } catch { threw = true; }
  assert(threw, 'bad target throws');
  threw = false;
  try { buildReferRequest({ ...base, callId: 'a\r\nb' }); } catch { threw = true; }
  assert(threw, 'line break in header throws');

  // Parsing
  assert(parseSipResponseLine('SIP/2.0 202 Accepted')?.status === 202, 'status parse');
  assert(parseSipResponseLine('INVITE sip:x SIP/2.0') === null, 'request is not a response');
  assert(parseCseqHeader('2 REFER')?.method === 'REFER', 'cseq parse');
  assert(referOutcome(100) === 'pending' && referOutcome(202) === 'accepted' && referOutcome(405) === 'failed', 'outcomes');

  // Tracker: accepted
  const tracker = new ReferTracker();
  let sends = 0;
  const accepted = tracker.wait('c1', 2, () => { sends += 1; }, 2000, 500);
  assert(tracker.handleResponse('c1', '2 REFER', 'SIP/2.0 100 Trying') === true, '100 consumed');
  assert(tracker.handleResponse('c1', '2 REFER', 'SIP/2.0 202 Accepted') === true, '202 consumed');
  const okRes = await accepted;
  assert(okRes.ok && okRes.message.startsWith('202'), 'accepted result');
  assert(sends === 1, 'sent once when answered fast');

  // Tracker: refusal
  const refused = tracker.wait('c2', 3, () => {}, 2000, 500);
  tracker.handleResponse('c2', '3 REFER', 'SIP/2.0 405 Method Not Allowed');
  const refRes = await refused;
  assert(!refRes.ok && refRes.message.startsWith('405'), 'refusal result');

  // Tracker: unrelated or non-REFER responses are ignored
  assert(tracker.handleResponse('nope', '1 REFER', 'SIP/2.0 200 OK') === false, 'unknown call ignored');
  const bye = tracker.wait('c3', 4, () => {}, 2000, 500);
  assert(tracker.handleResponse('c3', '4 BYE', 'SIP/2.0 200 OK') === false, 'BYE response ignored');
  tracker.cancel('c3');
  const byeRes = await bye;
  assert(!byeRes.ok, 'cancel fails the wait');

  // Tracker: retry then timeout
  let retrySends = 0;
  const timedOut = await tracker.wait('c4', 5, () => { retrySends += 1; }, 300, 100);
  assert(!timedOut.ok && /timed out/.test(timedOut.message), 'timeout result');
  assert(retrySends === 2, `resent once over UDP (sent ${retrySends})`);

  console.log('SIP REFER verification passed.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
