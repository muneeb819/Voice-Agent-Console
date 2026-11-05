import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './data-paths';

// Browser test audio is deliberately separate from VICIdial bridge recordings.
export const SIMULATOR_RECORDINGS_DIR = path.join(DATA_DIR, 'simulator-recordings');
export const MAX_SIMULATOR_RECORDING_BYTES = 20 * 1024 * 1024;

const RECORDING_TYPES: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
};

function safeFilePath(fileName: string): string {
  if (!/^sim_[a-z0-9]+_[a-f0-9]{6}\.(?:webm|ogg|m4a)$/.test(fileName)) {
    throw new Error('Invalid browser recording filename');
  }
  return path.join(SIMULATOR_RECORDINGS_DIR, fileName);
}

function checkedDirectoryExists(): boolean {
  try {
    const stat = fs.lstatSync(SIMULATOR_RECORDINGS_DIR);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Browser recording directory is not a private directory');
    return true;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
}

export function isSupportedRecording(data: Buffer, mime: string): boolean {
  if (!Buffer.isBuffer(data) || data.length === 0 || data.length > MAX_SIMULATOR_RECORDING_BYTES) return false;
  if (mime === 'audio/webm') return data.length >= 4 && data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (mime === 'audio/ogg') return data.length >= 4 && data.toString('ascii', 0, 4) === 'OggS';
  if (mime === 'audio/mp4') return data.length >= 12 && data.toString('ascii', 4, 8) === 'ftyp';
  return false;
}

/** Write one opt-in recording with owner-only permissions; never overwrite. */
export function writeSimulatorRecording(callId: string, data: Buffer, mime: string): string {
  const ext = RECORDING_TYPES[mime];
  if (!ext || !isSupportedRecording(data, mime)) throw new Error('Unsupported or invalid browser recording');
  const fileName = `${callId}.${ext}`;
  const fullPath = safeFilePath(fileName);
  fs.mkdirSync(SIMULATOR_RECORDINGS_DIR, { recursive: true, mode: 0o700 });
  if (!checkedDirectoryExists()) throw new Error('Browser recording directory is unavailable');
  fs.chmodSync(SIMULATOR_RECORDINGS_DIR, 0o700);
  let fd: number | undefined;
  try {
    fd = fs.openSync(fullPath, 'wx', 0o600);
    fs.writeFileSync(fd, data);
    fs.closeSync(fd);
    fd = undefined;
    return fileName;
  } catch (err) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
      try { fs.unlinkSync(fullPath); } catch {}
    }
    throw err;
  }
}

/** Reject path traversal and symlinks; missing files are reported as unavailable. */
export function resolveSimulatorRecording(fileName: string): string | null {
  const fullPath = safeFilePath(fileName);
  if (!checkedDirectoryExists()) return null;
  try {
    const stat = fs.lstatSync(fullPath);
    return stat.isFile() && !stat.isSymbolicLink() ? fullPath : null;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

/** Deleting a missing file is harmless, but other filesystem failures must be visible. */
export function removeSimulatorRecording(fileName: string | null | undefined): void {
  if (!fileName) return;
  const fullPath = safeFilePath(fileName);
  if (!checkedDirectoryExists()) return;
  try { fs.unlinkSync(fullPath); } catch (err: any) { if (err?.code !== 'ENOENT') throw err; }
}
