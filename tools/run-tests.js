const childProcess = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const allSteps = ['step1', 'step2', 'step3', 'step4'];
const requestedSteps = process.argv.slice(2);
const steps = requestedSteps.length ? requestedSteps : allSteps;

if (steps.some((step) => !allSteps.includes(step))) {
  console.error(`Unknown test step. Choose: ${allSteps.join(', ')}`);
  process.exit(2);
}

function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        probe.close(() => reject(new Error('Could not reserve a local test port')));
        return;
      }
      const port = address.port;
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForServer(server, url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Debug server exited early with code ${server.exitCode}`);
    }
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for the local debug server at ${url}`);
}

async function stopServer(server) {
  if (!server || server.exitCode !== null) return;
  server.kill();
  await new Promise((resolve) => server.once('exit', resolve));
}

async function main() {
  const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-agent-console-test-'));
  let server;
  let exitCode = 0;

  try {
    const port = await findAvailablePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const env = {
      ...process.env,
      VAC_DATA_DIR: testDataDir,
      TEST_URL: baseUrl,
      HOST: '127.0.0.1',
      PORT: String(port),
      AUDIOSOCKET_PORT: '0',
      BRIDGE_SIP_PORT: '0',
      ADMIN_PASSWORD: '',
      BRIDGE_ALLOWED_IPS: '127.0.0.1,::1',
    };

    server = childProcess.spawn(process.execPath, [tsxCli, 'src/server.ts'], {
      cwd: root,
      env,
      stdio: 'inherit',
    });
    await waitForServer(server, baseUrl);

    for (const step of steps) {
      console.log(`\n=== Running ${step} verification ===`);
      const result = childProcess.spawnSync(
        process.execPath,
        [tsxCli, path.join('tests', `${step}-verify.ts`)],
        { cwd: root, env, stdio: 'inherit' }
      );
      if (result.error) throw result.error;
      if (result.status !== 0) {
        exitCode = result.status || 1;
        break;
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    exitCode = 1;
  } finally {
    await stopServer(server);
    fs.rmSync(testDataDir, { recursive: true, force: true });
  }

  process.exitCode = exitCode;
}

main();