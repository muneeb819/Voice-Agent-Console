"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPreferredLanIpv4 = getPreferredLanIpv4;
exports.discoverActiveTunnelUrl = discoverActiveTunnelUrl;
exports.getCachedTunnelUrlSync = getCachedTunnelUrlSync;
exports.isTunnelProxyReady = isTunnelProxyReady;
exports.startPublicDemoTunnel = startPublicDemoTunnel;
exports.stopPublicDemoTunnel = stopPublicDemoTunnel;
const child_process_1 = __importDefault(require("child_process"));
const fs_1 = __importDefault(require("fs"));
const https_1 = __importDefault(require("https"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const ROOT_DIR = path_1.default.resolve(__dirname, '..');
const LOGS_DIR = path_1.default.join(ROOT_DIR, 'logs');
const TOOLS_DIR = path_1.default.join(ROOT_DIR, 'tools');
const DEMO_URL_FILE = path_1.default.join(LOGS_DIR, 'public-demo-url.txt');
let managedTunnelProc = null;
let managedTunnelUrl = null;
let startingPromise = null;
function getPreferredLanIpv4() {
    const nets = os_1.default.networkInterfaces();
    for (const list of Object.values(nets)) {
        for (const iface of list || []) {
            if (iface.family === 'IPv4' &&
                !iface.internal &&
                !iface.address.startsWith('169.254.') &&
                !iface.address.startsWith('172.')) {
                return iface.address;
            }
        }
    }
    return null;
}
function downloadWithRedirects(url, destPath, redirectsLeft = 6) {
    return new Promise((resolve, reject) => {
        if (redirectsLeft <= 0) {
            reject(new Error('Too many redirects while downloading cloudflared'));
            return;
        }
        https_1.default
            .get(url, { headers: { 'User-Agent': 'Voice-Agent-Console-Tunnel/1.0' } }, (res) => {
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                const nextUrl = new URL(res.headers.location, url).toString();
                downloadWithRedirects(nextUrl, destPath, redirectsLeft - 1).then(resolve, reject);
                return;
            }
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`Download failed with HTTP ${res.statusCode}`));
                return;
            }
            fs_1.default.mkdirSync(path_1.default.dirname(destPath), { recursive: true });
            const tmpPath = `${destPath}.part`;
            const out = fs_1.default.createWriteStream(tmpPath);
            res.pipe(out);
            out.on('finish', () => {
                out.close(() => {
                    try {
                        if (fs_1.default.existsSync(destPath))
                            fs_1.default.unlinkSync(destPath);
                        fs_1.default.renameSync(tmpPath, destPath);
                        if (process.platform !== 'win32') {
                            fs_1.default.chmodSync(destPath, 0o755);
                        }
                        resolve(destPath);
                    }
                    catch (err) {
                        reject(err);
                    }
                });
            });
            out.on('error', (err) => {
                try {
                    fs_1.default.unlinkSync(tmpPath);
                }
                catch { }
                reject(err);
            });
        })
            .on('error', reject);
    });
}
async function ensureCloudflaredBin() {
    const isWin = process.platform === 'win32';
    const localBin = path_1.default.join(TOOLS_DIR, isWin ? 'cloudflared.exe' : 'cloudflared');
    if (fs_1.default.existsSync(localBin) && fs_1.default.statSync(localBin).size > 1_000_000) {
        return localBin;
    }
    const lookupCmd = isWin ? 'where.exe' : 'which';
    const check = child_process_1.default.spawnSync(lookupCmd, ['cloudflared'], { encoding: 'utf8' });
    if (check.status === 0 && check.stdout.trim()) {
        return check.stdout.trim().split(/\r?\n/)[0].trim();
    }
    let downloadUrl = '';
    if (isWin) {
        downloadUrl =
            process.arch === 'arm64'
                ? 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-arm64.exe'
                : 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
    }
    else if (process.platform === 'linux') {
        downloadUrl =
            process.arch === 'arm64'
                ? 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64'
                : 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';
    }
    else {
        throw new Error('Install cloudflared (`brew install cloudflared`) to launch a public demo tunnel on macOS.');
    }
    await downloadWithRedirects(downloadUrl, localBin);
    return localBin;
}
/**
 * Probes any running cloudflared quick-tunnel metrics server (ports 20241..20246)
 * so even an externally started PowerShell cloudflared instance is auto-detected!
 */
async function discoverActiveTunnelUrl() {
    const envUrl = String(process.env.PUBLIC_DEMO_URL || '').trim();
    if (/^https?:\/\//i.test(envUrl))
        return envUrl.replace(/\/+$/, '');
    if (managedTunnelProc && managedTunnelProc.exitCode === null && managedTunnelUrl) {
        return managedTunnelUrl;
    }
    for (const metricsPort of [20241, 20242, 20243, 20244, 20245]) {
        try {
            const res = await fetch(`http://localhost:${metricsPort}/quicktunnel`, {
                signal: AbortSignal.timeout(220),
            });
            if (res.ok) {
                const data = (await res.json());
                const host = String(data?.hostname || '').trim();
                if (host && host.includes('.')) {
                    const full = host.startsWith('http') ? host : `https://${host}`;
                    try {
                        fs_1.default.mkdirSync(LOGS_DIR, { recursive: true });
                        fs_1.default.writeFileSync(DEMO_URL_FILE, `${full}\n`, 'utf8');
                    }
                    catch { }
                    return full.replace(/\/+$/, '');
                }
            }
        }
        catch {
            // Port not listening; continue
        }
    }
    try {
        if (fs_1.default.existsSync(DEMO_URL_FILE)) {
            const saved = fs_1.default.readFileSync(DEMO_URL_FILE, 'utf8').trim();
            if (/^https?:\/\//i.test(saved))
                return saved.replace(/\/+$/, '');
        }
    }
    catch { }
    return null;
}
function getCachedTunnelUrlSync() {
    const envUrl = String(process.env.PUBLIC_DEMO_URL || '').trim();
    if (/^https?:\/\//i.test(envUrl))
        return envUrl.replace(/\/+$/, '');
    if (managedTunnelProc && managedTunnelProc.exitCode === null && managedTunnelUrl) {
        return managedTunnelUrl;
    }
    try {
        if (fs_1.default.existsSync(DEMO_URL_FILE)) {
            const saved = fs_1.default.readFileSync(DEMO_URL_FILE, 'utf8').trim();
            if (/^https?:\/\//i.test(saved))
                return saved.replace(/\/+$/, '');
        }
    }
    catch { }
    return null;
}
function tunnelUpstreamHost() {
    const host = String(process.env.HOST || '').trim();
    return host && /^[a-z0-9.-]+$/i.test(host) && !['0.0.0.0', 'localhost'].includes(host)
        ? host : '127.0.0.1';
}
// Probe the same listener used by cloudflared. The origin guard only accepts
// this forwarded HTTPS origin when the connecting address is a trusted proxy.
async function isTunnelProxyReady(localPort) {
    try {
        const res = await fetch(`http://${tunnelUpstreamHost()}:${localPort}/api/health`, {
            headers: {
                Origin: 'https://vac-proxy-probe.invalid',
                'X-Forwarded-Host': 'vac-proxy-probe.invalid',
                'X-Forwarded-Proto': 'https',
            },
            signal: AbortSignal.timeout(2000),
        });
        return res.ok;
    }
    catch {
        return false;
    }
}
async function startPublicDemoTunnel(localPort) {
    const existing = await discoverActiveTunnelUrl();
    if (existing) {
        return { ok: true, publicUrl: existing };
    }
    if (startingPromise)
        return startingPromise;
    startingPromise = (async () => {
        try {
            const cfBin = await ensureCloudflaredBin();
            fs_1.default.mkdirSync(LOGS_DIR, { recursive: true });
            // Match the listener; use IPv4 loopback for wildcard/local defaults.
            const upstreamUrl = `http://${tunnelUpstreamHost()}:${localPort}`;
            const proc = child_process_1.default.spawn(cfBin, ['tunnel', '--protocol', 'http2', '--url', upstreamUrl, '--no-autoupdate'], {
                cwd: ROOT_DIR,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            managedTunnelProc = proc;
            managedTunnelUrl = null;
            const foundUrl = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    reject(new Error('Timed out waiting for Cloudflare Quick Tunnel URL (check outbound internet).'));
                }, 22_000);
                const onChunk = (chunk) => {
                    const txt = chunk.toString('utf8');
                    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(txt);
                    if (m) {
                        clearTimeout(timer);
                        resolve(m[0].replace(/\/+$/, ''));
                    }
                };
                proc.stdout?.on('data', onChunk);
                proc.stderr?.on('data', onChunk);
                proc.once('error', (err) => {
                    clearTimeout(timer);
                    reject(err);
                });
                proc.once('exit', (code) => {
                    clearTimeout(timer);
                    reject(new Error(`cloudflared exited early with code ${code}`));
                });
            });
            managedTunnelUrl = foundUrl;
            try {
                fs_1.default.writeFileSync(DEMO_URL_FILE, `${foundUrl}\n`, 'utf8');
            }
            catch { }
            proc.once('exit', () => {
                if (managedTunnelProc === proc) {
                    managedTunnelProc = null;
                    managedTunnelUrl = null;
                    try {
                        if (fs_1.default.existsSync(DEMO_URL_FILE))
                            fs_1.default.unlinkSync(DEMO_URL_FILE);
                    }
                    catch { }
                }
            });
            return { ok: true, publicUrl: foundUrl };
        }
        catch (err) {
            return {
                ok: false,
                publicUrl: null,
                error: err?.message || 'Unable to start public demo tunnel',
            };
        }
        finally {
            startingPromise = null;
        }
    })();
    return startingPromise;
}
function stopPublicDemoTunnel() {
    if (managedTunnelProc && managedTunnelProc.exitCode === null) {
        managedTunnelProc.kill();
    }
    managedTunnelProc = null;
    managedTunnelUrl = null;
    try {
        if (fs_1.default.existsSync(DEMO_URL_FILE))
            fs_1.default.unlinkSync(DEMO_URL_FILE);
    }
    catch { }
}
