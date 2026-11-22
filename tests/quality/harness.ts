// Quality harness: every check is executed and recorded; nothing is counted
// without running. A check passes only if its function returns without throwing
// and does not return false.
import assert from 'node:assert/strict';

export interface CheckResult {
  id: number;
  area: string;
  module: string;
  family: string;
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
}

export const results: CheckResult[] = [];

export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => Math.floor(next() * (max - min + 1)) + min,
    pick: <T>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length)],
    bool: (p = 0.5) => next() < p,
    str: (len: number, alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') => {
      let s = '';
      for (let i = 0; i < len; i++) s += alphabet[Math.floor(next() * alphabet.length)];
      return s;
    },
    bytes: (len: number) => {
      const b = Buffer.alloc(len);
      for (let i = 0; i < len; i++) b[i] = Math.floor(next() * 256);
      return b;
    },
  };
}

const NASTY = ['', ' ', '\n', '\r\n', '\t', '"', "'", '&', '|', '<script>alert(1)</script>', '${process.exit()}', '{{ADMIN_PASSWORD}}',
  '\u0000', '‮', '😀', 'Ω≈ç√∫', '../../etc/passwd', '%00', 'null', 'undefined', '__proto__', 'constructor', '0', '-1', '1e309', 'NaN'];
export function fuzzString(r: ReturnType<typeof rng>, maxLen = 60): string {
  const mode = r.int(0, 4);
  if (mode === 0) return r.pick(NASTY);
  if (mode === 1) return r.str(r.int(0, maxLen));
  if (mode === 2) return r.str(r.int(0, maxLen), ' \t\n\'"&|<>{}[]()$%#@!~`^*\\/;:,.?=+-_');
  if (mode === 3) return Array.from({ length: r.int(0, maxLen) }, () => String.fromCodePoint(r.int(32, 0x2fff))).join('');
  return r.pick(NASTY) + r.str(r.int(0, maxLen / 2)) + r.pick(NASTY);
}

let current = { area: '', module: '', family: '' };
export function group(area: string, module: string, family: string) {
  current = { area, module, family };
}

function record(name: string, ok: boolean, detail: string, ms: number) {
  results.push({ id: results.length + 1, ...current, name, ok, detail: detail.slice(0, 400), ms });
}

export function check(name: string, fn: () => unknown): void {
  const t = performance.now();
  try {
    const out = fn();
    record(name, out !== false, out === false ? 'returned false' : '', performance.now() - t);
  } catch (err) {
    record(name, false, err instanceof Error ? err.message : String(err), performance.now() - t);
  }
}

export async function acheck(name: string, fn: () => Promise<unknown>): Promise<void> {
  const t = performance.now();
  try {
    const out = await fn();
    record(name, out !== false, out === false ? 'returned false' : '', performance.now() - t);
  } catch (err) {
    record(name, false, err instanceof Error ? err.message : String(err), performance.now() - t);
  }
}

export { assert };
