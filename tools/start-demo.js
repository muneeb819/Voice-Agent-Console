#!/usr/bin/env node
/**
 * One-Command Public Client Demo Launcher (`npm run demo`)
 * 1. Starts (or attaches to) Voice Agent Console on port 533 (HOST=115.186.137.240).
 * 2. Auto-downloads official `cloudflared` binary if not yet present in `tools/`.
 * 3. Opens an encrypted HTTPS + WSS tunnel (`https://*.trycloudflare.com`) over TCP/HTTP2
 *    so external clients on ANY internet connection get:
 *      - Sign Up / Sign In entry screen first (`/signup` & `/login`)
 *      - Browser Microphone permission (requires HTTPS for remote visitors)
 *      - Live Deepgram Voice Agent WebSocket (`wss://`) streaming
 */

const childProcess = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LOGS_DIR = path.join(ROOT, 'logs');
const TOOLS_DIR = path.join(ROOT, 'tools');
const DEMO_URL_FILE = path.join(LOGS_DIR, 'public-demo-url.txt');

fs.mkdirSync(LOGS_DIR, { recursive: true });
fs.mkdirSync(TOOLS_DIR, { recursive: true });

function downloadFileWithRedirects(url, destPath, redirectsLeft = 6) {
  return new Promise((resolve, reject) => {
    if (redirectsLeft <= 0) {
      reject(new Error('Too many redirects while downloading cloudflared'));
      return;
    }
    https
      .get(
        url,
        {
          headers: { 'User-Agent': 'Voice-Agent-Console-Demo-Launcher/1.0' },
        },
        (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            const nextUrl = new URL(res.headers.location, url).toString();
            downloadFileWithRedirects(nextUrl, destPath, redirectsLeft - 1).then(resolve, reject);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`Download failed with HTTP ${res.statusCode} from ${url}`));
            return;
          }
          const tmpPath = `${destPath}.part`;
          const out = fs.createWriteStream(tmpPath);
          const totalBytes = Number(res.headers['content-length'] || 0);
          let received = 0;
          let lastPct = -1;

          res.on('data', (chunk) => {
            received += chunk.length;
            if (totalBytes > 0) {
              const pct = Math.floor((received / totalBytes) * 100);
              if (pct >= lastPct + 20) {
                lastPct = pct;
                process.stdout.write(`  Downloading cloudflared... ${pct}%\n`);
              }
            }
          });

          res.pipe(out);
          out.on('finish', () => {
            out.close(() => {
              try {
                if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
                fs.renameSync(tmpPath, destPath);
                if (process.platform !== 'win32') {
                  fs.chmodSync(destPath, 0o755);
                }
                resolve(destPath);
              } catch (err) {
                reject(err);
              }
            });
          });
          out.on('error', (err) => {
            try {
              fs.unlinkSync(tmpPath);
            } catch {}
            reject(err);
          });
        }
      )
      .on('error', reject);
  });
}

async function ensureCloudflaredBinary() {
  const isWin = process.platform === 'win32';
  const localBin = path.join(TOOLS_DIR, isWin ? 'cloudflared.exe' : 'cloudflared');

  if (fs.existsSync(localBin) && fs.statSync(localBin).size > 1_000_000) {
    return localBin;
  }

  // Check system PATH
  const lookupCmd = isWin ? 'where.exe' : 'which';
  const pathCheck = childProcess.spawnSync(lookupCmd, ['cloudflared'], { encoding: 'utf8' });
  if (pathCheck.status === 0 && pathCheck.stdout.trim()) {
    return pathCheck.stdout.trim().split(/\r?\n/)[0].trim();
  }

  let downloadUrl = '';
  if (isWin) {
    downloadUrl =
      process.arch === 'arm64'
        ? 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-arm64.exe'
        : 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
  } else if (process.platform === 'linux') {
    downloadUrl =
      process.arch === 'arm64'
        ? 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64'
        : 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';
  } else {
    throw new Error(
      'Automatic cloudflared download is supported on Windows and Linux. On macOS run: brew install cloudflared'
    );
  }

  console.log('[Demo] Downloading official Cloudflare Tunnel binary (one-time setup)...');
  await downloadFileWithRedirects(downloadUrl, localBin);
  console.log(`[Demo] Saved tunnel binary to ${localBin}`);
  return localBin;
}

async function isConsoleHealthy(port) {
  try {
    const res = await fetch(`http://localhost:${port}/api/health`, {
      signal: AbortSignal.timeout(1200),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return Boolean(data && data.ok && data.service === 'voice-agent-console');
  } catch {
    return false;
  }
}

function getLanIp() {
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const iface of list || []) {
      if (
        iface.family === 'IPv4' &&
        !iface.internal &&
        !iface.address.startsWith('169.254.') &&
        !iface.address.startsWith('172.')
      ) {
        return iface.address;
      }
    }
  }
  return null;
}

async function main() {
  const distServer = path.join(ROOT, 'dist', 'server.js');
  if (!fs.existsSync(distServer)) {
    console.log('[Demo] Building TypeScript...');
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const buildRes = childProcess.spawnSync(npmCmd, ['run', 'build'], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    if (buildRes.status !== 0) process.exit(buildRes.status || 1);
  }

  try {
    if (fs.existsSync(DEMO_URL_FILE)) fs.unlinkSync(DEMO_URL_FILE);
  } catch {}

  const targetPort = Number(process.env.PORT || 533);
  let boundPort = targetPort;
  let serverProc = null;

  if (await isConsoleHealthy(targetPort)) {
    console.log(`[Demo] Attached to running Voice Agent Console on port ${targetPort}.`);
  } else {
    console.log(`[Demo] Starting Voice Agent Console on port ${targetPort}...`);
    serverProc = childProcess.spawn(process.execPath, [distServer], {
      cwd: ROOT,
      env: {
        ...process.env,
        VAC_DEBUG: process.env.VAC_DEBUG || '1',
        HOST: process.env.HOST || '115.186.137.240',
        PORT: String(targetPort),
        BRIDGE_BIND_HOST: process.env.BRIDGE_BIND_HOST || '115.186.137.240',
        BRIDGE_ALLOWED_IPS: process.env.BRIDGE_ALLOWED_IPS || '115.186.137.240',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    serverProc.stdout.on('data', (chunk) => {
      const txt = chunk.toString('utf8');
      process.stdout.write(txt);
      const m = /bound\s+[^:]+:(\d+)/i.exec(txt);
      if (m) boundPort = Number(m[1]);
    });
    serverProc.stderr.on('data', (chunk) => {
      process.stderr.write(chunk.toString('utf8'));
    });

    const deadline = Date.now() + 20_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (serverProc.exitCode !== null) {
        console.error(`[Demo] Server exited early with code ${serverProc.exitCode}`);
        process.exit(serverProc.exitCode || 1);
      }
      if (await isConsoleHealthy(boundPort)) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!ready) {
      console.error(`[Demo] Timed out waiting for Voice Agent Console on port ${boundPort}`);
      process.exit(1);
    }
  }

  const cfBin = await ensureCloudflaredBinary();
  console.log(`[Demo] Opening encrypted HTTPS client demo tunnel -> http://localhost:${boundPort} ...`);

  const tunnelProc = childProcess.spawn(
    cfBin,
    ['tunnel', '--protocol', 'http2', '--url', `http://localhost:${boundPort}`, '--no-autoupdate'],
    {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  let printedBanner = false;
  const handleTunnelOutput = (chunk) => {
    const text = chunk.toString('utf8');
    const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(text);
    if (match && !printedBanner) {
      printedBanner = true;
      const publicUrl = match[0];
      try {
        fs.writeFileSync(DEMO_URL_FILE, publicUrl + '\n', 'utf8');
      } catch {}
      const lanIp = getLanIp();
      console.log('\n========================================================================');
      console.log('  CLIENT DEMO IS LIVE — ACCESSIBLE FROM ANY INTERNET CONNECTION');
      console.log('========================================================================');
      console.log(`  Client Demo URL (HTTPS + Mic) :  ${publicUrl}`);
      console.log(`  Client Sign-Up Page           :  ${publicUrl}/signup`);
      console.log(`  Client Sign-In Page           :  ${publicUrl}/login`);
      console.log(`  Local Console URL             :  http://localhost:${boundPort}`);
      if (lanIp) {
        console.log(`  Office Wi-Fi / LAN URL        :  http://${lanIp}:${boundPort}`);
      }
      console.log('========================================================================');
      console.log('  Send the "Client Demo URL" above to your client on WhatsApp / Email.');
      console.log('  Keep this window open during the demo. Press Ctrl+C to stop.');
      console.log('========================================================================\n');
    }
  };

  tunnelProc.stdout.on('data', handleTunnelOutput);
  tunnelProc.stderr.on('data', handleTunnelOutput);

  const cleanup = () => {
    try {
      if (fs.existsSync(DEMO_URL_FILE)) fs.unlinkSync(DEMO_URL_FILE);
    } catch {}
    if (tunnelProc && tunnelProc.exitCode === null) {
      tunnelProc.kill();
    }
    if (serverProc && serverProc.exitCode === null) {
      serverProc.kill();
    }
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  tunnelProc.on('exit', (code) => {
    console.error(`[Demo] Public tunnel closed (code ${code}).`);
    cleanup();
  });
}

main().catch((err) => {
  console.error('[Demo] Failed to start public client demo:', err.message || err);
  process.exit(1);
});
