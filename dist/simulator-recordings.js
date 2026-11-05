"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_SIMULATOR_RECORDING_BYTES = exports.SIMULATOR_RECORDINGS_DIR = void 0;
exports.isSupportedRecording = isSupportedRecording;
exports.writeSimulatorRecording = writeSimulatorRecording;
exports.resolveSimulatorRecording = resolveSimulatorRecording;
exports.removeSimulatorRecording = removeSimulatorRecording;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const data_paths_1 = require("./data-paths");
// Browser test audio is deliberately separate from VICIdial bridge recordings.
exports.SIMULATOR_RECORDINGS_DIR = path_1.default.join(data_paths_1.DATA_DIR, 'simulator-recordings');
exports.MAX_SIMULATOR_RECORDING_BYTES = 20 * 1024 * 1024;
const RECORDING_TYPES = {
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/mp4': 'm4a',
};
function safeFilePath(fileName) {
    if (!/^sim_[a-z0-9]+_[a-f0-9]{6}\.(?:webm|ogg|m4a)$/.test(fileName)) {
        throw new Error('Invalid browser recording filename');
    }
    return path_1.default.join(exports.SIMULATOR_RECORDINGS_DIR, fileName);
}
function checkedDirectoryExists() {
    try {
        const stat = fs_1.default.lstatSync(exports.SIMULATOR_RECORDINGS_DIR);
        if (!stat.isDirectory() || stat.isSymbolicLink())
            throw new Error('Browser recording directory is not a private directory');
        return true;
    }
    catch (err) {
        if (err?.code === 'ENOENT')
            return false;
        throw err;
    }
}
function isSupportedRecording(data, mime) {
    if (!Buffer.isBuffer(data) || data.length === 0 || data.length > exports.MAX_SIMULATOR_RECORDING_BYTES)
        return false;
    if (mime === 'audio/webm')
        return data.length >= 4 && data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    if (mime === 'audio/ogg')
        return data.length >= 4 && data.toString('ascii', 0, 4) === 'OggS';
    if (mime === 'audio/mp4')
        return data.length >= 12 && data.toString('ascii', 4, 8) === 'ftyp';
    return false;
}
/** Write one opt-in recording with owner-only permissions; never overwrite. */
function writeSimulatorRecording(callId, data, mime) {
    const ext = RECORDING_TYPES[mime];
    if (!ext || !isSupportedRecording(data, mime))
        throw new Error('Unsupported or invalid browser recording');
    const fileName = `${callId}.${ext}`;
    const fullPath = safeFilePath(fileName);
    fs_1.default.mkdirSync(exports.SIMULATOR_RECORDINGS_DIR, { recursive: true, mode: 0o700 });
    if (!checkedDirectoryExists())
        throw new Error('Browser recording directory is unavailable');
    fs_1.default.chmodSync(exports.SIMULATOR_RECORDINGS_DIR, 0o700);
    let fd;
    try {
        fd = fs_1.default.openSync(fullPath, 'wx', 0o600);
        fs_1.default.writeFileSync(fd, data);
        fs_1.default.closeSync(fd);
        fd = undefined;
        return fileName;
    }
    catch (err) {
        if (fd !== undefined) {
            try {
                fs_1.default.closeSync(fd);
            }
            catch { }
            try {
                fs_1.default.unlinkSync(fullPath);
            }
            catch { }
        }
        throw err;
    }
}
/** Reject path traversal and symlinks; missing files are reported as unavailable. */
function resolveSimulatorRecording(fileName) {
    const fullPath = safeFilePath(fileName);
    if (!checkedDirectoryExists())
        return null;
    try {
        const stat = fs_1.default.lstatSync(fullPath);
        return stat.isFile() && !stat.isSymbolicLink() ? fullPath : null;
    }
    catch (err) {
        if (err?.code === 'ENOENT')
            return null;
        throw err;
    }
}
/** Deleting a missing file is harmless, but other filesystem failures must be visible. */
function removeSimulatorRecording(fileName) {
    if (!fileName)
        return;
    const fullPath = safeFilePath(fileName);
    if (!checkedDirectoryExists())
        return;
    try {
        fs_1.default.unlinkSync(fullPath);
    }
    catch (err) {
        if (err?.code !== 'ENOENT')
            throw err;
    }
}
