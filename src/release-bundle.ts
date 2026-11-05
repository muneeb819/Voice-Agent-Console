import childProcess from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The manifest is an explicit list of project files, not recursive directory
// inclusion. Update tools/release-manifest.json when adding a release file.
const MANIFEST_PATH = path.join('tools', 'release-manifest.json');
const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '.cache', '__pycache__', '.pytest_cache', 'data', '.dev-data', 'logs', 'recordings', 'simulator-recordings']);
// A partial installation may omit optional docs or speech-service files, but
// never claim a successful install bundle if these bootstrap files are absent.
const REQUIRED_FILES = [
  '.env.example', 'package.json', 'package-lock.json', 'tsconfig.json',
  'deploy/vicibox-install.sh', 'deploy/voice-agent-bridge.service',
  'src/server.ts', 'public/index.html', 'public/app.js', 'public/styles.css',
  'dist/server.js', 'dist/release-bundle.js', 'dist/request-origin.js',
  'tools/release-manifest.json',
];

function isSafeManifestFile(projectRoot: string, relative: string): boolean {
  if (!relative || path.posix.isAbsolute(relative) || relative.includes('\\')) return false;
  const parts = relative.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return false;
  if (parts.slice(0, -1).some((part) => EXCLUDED_DIRS.has(part))) return false;
  const name = parts[parts.length - 1];
  if (name !== '.env.example' && /^\.env(?:\.|$)/i.test(name)) return false;
  if (/(?:\.sqlite(?:3)?(?:-shm|-wal)?|\.db|\.(?:wav|webm|ogg|m4a|mp3|opus)|\.log|\.tar\.gz|\.pyc)$/i.test(name)) return false;
  if (name === 'cloudflared' || name === 'cloudflared.exe') return false;

  // Every component is checked: a symlinked parent could otherwise traverse
  // outside the release root even if the final file itself is regular.
  let current = projectRoot;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(current); } catch { return false; }
    if (stat.isSymbolicLink()) return false;
    if (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()) return false;
  }
  return true;
}

export function createReleaseBundle(projectRoot: string, bundlePath: string): void {
  const parent = path.dirname(projectRoot);
  const rootName = path.basename(projectRoot);
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, MANIFEST_PATH), 'utf8'));
  if (!Array.isArray(manifest) || !manifest.every((entry) => typeof entry === 'string')) {
    throw new Error('Invalid release manifest');
  }
  const listed = [...new Set(manifest as string[])];
  const available = listed.filter((entry) => isSafeManifestFile(projectRoot, entry));
  const required = new Set([...REQUIRED_FILES, ...listed.filter((entry) => /^(?:src|public|deploy|dist)\//.test(entry))]);
  const missing = [...required].filter((entry) => !available.includes(entry));
  if (missing.length) throw new Error(`Release bundle is missing required files: ${missing.join(', ')}`);
  const entries = available.map((entry) => path.posix.join(rootName, entry));

  fs.mkdirSync(path.dirname(bundlePath), { recursive: true });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vac-release-'));
  const listPath = path.join(scratch, 'files.list');
  const tempBundle = `${bundlePath}.${crypto.randomUUID()}.tmp`;
  try {
    // NUL-delimited names prevent filenames from being interpreted as tar options.
    fs.writeFileSync(listPath, entries.join('\0') + '\0');
    childProcess.execFileSync('tar', ['-czf', tempBundle, '-C', parent, '--no-recursion', '--null', '-T', listPath], { timeout: 20000 });
    fs.renameSync(tempBundle, bundlePath);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
    try { fs.unlinkSync(tempBundle); } catch {}
  }
}
