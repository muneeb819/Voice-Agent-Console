import dgram from 'dgram';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { DATA_DIR } from '../src/data-paths';
import { getBotSleep, isBotSleeping, setBotSleep } from '../src/bot-sleep';
import { createServerWithSimulator } from '../src/server';

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

/** Sends one INVITE and returns the full text of the first final response. */
function invite(sipPort: number, exten: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = dgram.createSocket('udp4');
    const timer = setTimeout(() => { try { u.close(); } catch {} reject(new Error('No SIP answer')); }, 4000);
    u.on('message', (msg) => {
      const txt = msg.toString('utf8');
      if (/^SIP\/2\.0\s+[2-6]\d\d/.test(txt)) {
        clearTimeout(timer);
        try { u.close(); } catch {}
        resolve(txt);
      }
    });
    u.bind(0, 'localhost', () => {
      const lport = (u.address() as net.AddressInfo).port;
      const sdp = ['v=0', 'o=root 1 1 IN IP4 localhost', 's=Test', 'c=IN IP4 localhost', 't=0 0', 'm=audio 40000 RTP/AVP 0', 'a=rtpmap:0 PCMU/8000', ''].join('\r\n');
      const pkt = [
        `INVITE sip:${exten}@localhost:${sipPort} SIP/2.0`,
        `Via: SIP/2.0/UDP localhost:${lport};branch=z9hG4bKsleep`,
        'From: "V1027153012000104892" <sip:3055550192@localhost>;tag=t1',
        `To: <sip:${exten}@localhost:${sipPort}>`,
        `Call-ID: sleep-${Date.now()}@localhost`,
        'CSeq: 1 INVITE',
        'Content-Type: application/sdp',
        `Content-Length: ${Buffer.byteLength(sdp)}`,
        '',
        sdp,
      ].join('\r\n');
      u.send(Buffer.from(pkt, 'utf8'), sipPort, 'localhost');
    });
  });
}

async function run() {
  // The switch starts awake and survives a restart (it is stored in its own file).
  assert(!isBotSleeping(), 'bots start awake');
  const slept = setBotSleep(true, 'test');
  assert(slept.sleeping && slept.since, 'sleep recorded with a time');
  assert(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'bot-sleep.json'), 'utf8')).sleeping === true, 'sleep state is written to its own file');
  assert(getBotSleep().by === 'test', 'who changed it is kept');

  const { server, viciBridge } = createServerWithSimulator({ enableBridge: true, host: 'localhost', audioSocketPort: 0, sipPort: 0 });
  const bridge = viciBridge!;
  await bridge.start();
  try {
    const sipPort = bridge.getStatus().sipPort;

    // Asleep: a call is turned away before any campaign or provider is touched.
    const asleepReply = await invite(sipPort, '88003');
    assert(/^SIP\/2\.0 503/.test(asleepReply), `asleep INVITE answered 503, got ${asleepReply.split('\r\n')[0]}`);
    assert(/Bots asleep/i.test(asleepReply), 'asleep reply says why');
    assert(bridge.getStatus().rejectedAsleepCount === 1, 'asleep rejection is counted');
    assert(bridge.getStatus().botSleep.sleeping === true, 'status shows the bots are asleep');

    // The dialer pre-registration path refuses too.
    let threw = '';
    try { bridge.registerPreCall({ uniqueid: 'u1', exten: '88003', vici_cid: 'V1027153012000104892' } as any); } catch (e: any) { threw = e.message; }
    assert(/asleep/i.test(threw), `register-call refused while asleep: ${threw}`);
    assert(bridge.getStatus().rejectedAsleepCount === 2, 'second rejection counted');

    // Awake again: the sleep guard no longer answers.
    setBotSleep(false, 'test');
    const awakeReply = await invite(sipPort, '88003');
    assert(!/Bots asleep/i.test(awakeReply), 'awake INVITE is no longer turned away as asleep');
    assert(bridge.getStatus().botSleep.sleeping === false, 'status shows the bots are awake');
    assert(bridge.hangupAllCalls() === 0, 'hangupAllCalls with no calls ends none');
    console.log('Bot sleep verification passed.');
  } finally {
    await bridge.stop?.();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

run().then(() => process.exit(0), (err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
