const childProcess = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const allSteps = ['step1', 'step2', 'live-bot', 'simulator-recording', 'greetings', 'opening', 'bridge-opening', 'step3', 'step4', 'security', 'backend-audit', 'health', 'static-site', 'static-console'];
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
    probe.listen(0, 'localhost', () => {
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
    const baseUrl = `http://localhost:${port}`;
    const env = {
      ...process.env,
      VAC_DATA_DIR: testDataDir,
      VAC_ENV_FILE: path.join(testDataDir, '.env'),
      TEST_URL: baseUrl,
      HOST: 'localhost',
      PORT: String(port),
      BRIDGE_BIND_HOST: 'localhost',
      AUDIOSOCKET_PORT: '0',
      BRIDGE_SIP_PORT: '0',
      ADMIN_PASSWORD: '',
      BRIDGE_ALLOWED_IPS: 'localhost,::1',
      // Offline by default: test runs must not spend or modify real accounts.
      DEEPGRAM_API_KEY: process.env.VAC_TEST_LIVE === '1' ? (process.env.DEEPGRAM_API_KEY || '') : '',
      SPEECH_SERVICE_API_KEY: '',
      SPEECH_SERVICE_URL: '',
      ELEVENLABS_API_KEY: '',
      CARTESIA_API_KEY: '',
      OPENAI_API_KEY: '',
      GROQ_API_KEY: '',
      VICI_API_PASS: '',
      AMI_SECRET: '',
      CUSTOM_WEBHOOK_SECRET: '',
      DEEPGRAM_AGENT_URL: '',
      TRUST_PROXY: '',
    };
    if (process.env.VAC_TEST_LIVE !== '1') {
      const preload = path.join(root, 'tests', 'offline-fetch.cjs');
      env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ''} --require=${JSON.stringify(preload)}`.trim();
    }

    server = childProcess.spawn(process.execPath, [tsxCli, 'src/server.ts'], {
      cwd: root,
      env,
      stdio: 'inherit',
    });
    await waitForServer(server, baseUrl);

    for (const step of steps) {
      console.log(`\n=== Running ${step} verification ===`);
      // These suites create their own server and need a fresh account store.
      const stepEnv = { ...env };
      if (step === 'security' || step === 'backend-audit' || step === 'live-bot' || step === 'greetings' || step === 'opening' || step === 'bridge-opening') {
        stepEnv.VAC_DATA_DIR = path.join(testDataDir, step);
        fs.mkdirSync(stepEnv.VAC_DATA_DIR, { recursive: true });
        stepEnv.VAC_ENV_FILE = path.join(stepEnv.VAC_DATA_DIR, '.env');
      }
      const result = childProcess.spawnSync(
        process.execPath,
        [tsxCli, path.join('tests', `${step}-verify.ts`)],
        { cwd: root, env: stepEnv, stdio: 'inherit' }
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