import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { createDefaultState, normalizeState } from '../src/defaults';

// Settings saved by an older console still load, and the two fields nothing ever read are dropped.
const old = JSON.parse(JSON.stringify(normalizeState(createDefaultState())));
for (const c of old.campaigns) { c.attempts = 5; c.retry = 30; }
const loaded = normalizeState(old);
assert(loaded.campaigns.length > 0, 'old settings still load');
for (const c of loaded.campaigns) {
  assert(!('attempts' in c) && !('retry' in c), 'dial attempts and retry delay are gone from every campaign');
}
const fresh = normalizeState(createDefaultState());
assert(fresh.campaigns.every((c) => !('attempts' in c) && !('retry' in c)), 'new settings never carry them');

const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
for (const gone of ['Max dial attempts', 'Retry delay (min)', "'c.attempts'", "'c.retry'", '139 Flux v2', 'SIP:5062 & AudioSocket', 'Works on ALL ViciBox']) {
  assert(!app.includes(gone), `console no longer shows "${gone}"`);
}
assert(app.includes('Add the caller to the VICIdial DNC list when the bot records a Do-Not-Call result'), 'DNC label says what it really does');
assert(app.includes('for reference: set the real call times in VICIdial'), 'calling window says VICIdial decides');
assert(app.includes('Later · optional'), 'voice cloning is marked as later');
assert(!app.includes('were removed.'), 'no stale note about removed speed settings');

const types = fs.readFileSync(path.join(__dirname, '../src/types.ts'), 'utf8');
assert(!/\n\s+attempts: number;/.test(types) && !/\n\s+retry: number;/.test(types), 'the campaign type no longer has them');

console.log('console-cleanup-verify: all checks passed');
