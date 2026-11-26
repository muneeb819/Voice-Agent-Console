import assert from 'assert';
import { getConsoleState } from '../src/db';
import { generateViciConfig } from '../src/settings-builder';

/** Minimal Asterisk extension-pattern matcher: N=2-9, X=0-9, Z=1-9, [..] sets, '.' = one or more of anything. */
function asteriskMatches(pattern: string, exten: string): boolean {
  if (!pattern.startsWith('_')) return pattern === exten;
  const p = pattern.slice(1);
  let i = 0;
  let j = 0;
  while (i < p.length) {
    const c = p[i];
    if (c === '.') return j < exten.length; // needs at least one remaining character
    if (c === '!') return true;
    if (j >= exten.length) return false;
    const d = exten[j];
    if (c === 'X') { if (!/[0-9]/.test(d)) return false; }
    else if (c === 'Z') { if (!/[1-9]/.test(d)) return false; }
    else if (c === 'N') { if (!/[2-9]/.test(d)) return false; }
    else if (c === '[') {
      const end = p.indexOf(']', i);
      const set = p.slice(i + 1, end);
      let ok = false;
      for (let k = 0; k < set.length; k++) {
        if (set[k + 1] === '-' && k + 2 < set.length) { if (d >= set[k] && d <= set[k + 2]) ok = true; k += 2; }
        else if (set[k] === d) ok = true;
      }
      if (!ok) return false;
      i = end;
    } else if (c !== d) return false;
    i++; j++;
  }
  return j === exten.length;
}

const state = getConsoleState();
const text = generateViciConfig(state);
const patterns = [...text.matchAll(/^exten => (_[^,]+),1,/gm)].map((m) => m[1]);
assert(patterns.length >= 2, 'generated config contains the SIP and AudioSocket dialplan entries');

// Every real bot extension is aiExten + slot: 5 characters for slots 1-9, 6 for slots 10+.
for (const slot of [1, 2, 3, 4, 5, 9, 10, 12]) {
  const exten = `${state.vici.aiExten}${slot}`;
  for (const pattern of patterns) {
    assert(asteriskMatches(pattern, exten), `generated dialplan pattern ${pattern} must match bot extension ${exten}`);
  }
}
// Sanity: the old broken pattern would not have matched the 5-digit extension.
assert(!asteriskMatches(`_${state.vici.aiExten}X.`, `${state.vici.aiExten}3`), 'regression guard: _<prefix>X. does not match a 5-digit extension');
console.log('✓ dialplan: generated patterns match every bot extension (5- and 6-digit)');
