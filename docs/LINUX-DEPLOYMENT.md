# Deploying the Voice Agent Console on Linux

The console is a long-running Node.js service (HTTP + WebSocket) with a SQLite
data directory. It can be published on any **systemd Linux** host with nginx,
or run as a container on any Linux host with Docker.

Supported native targets:

- Debian 12 / Ubuntu 22.04 / 24.04
- RHEL 9, Rocky Linux 9, AlmaLinux 9
- Amazon Linux 2023

> Amazon Linux 2 is past end of support and uses `yum`/`amazon-linux-extras`;
> use Amazon Linux 2023 instead.

## Topology

```text
browser ──TLS──> nginx :533 (0.0.0.0) ──HTTP──> Node 127.0.0.1:534
```

Node stays on loopback. Only nginx is internet-facing. The native installer
creates a `voice-agent-console.service` systemd unit and an nginx TLS server
block.

Two settings matter:

| Setting | Why |
| --- | --- |
| `TRUST_PROXY=127.0.0.1` | The app issues `Secure` cookies and derives client IPs from `X-Forwarded-*`, but only from a trusted proxy. |
| `X-Forwarded-Host` | Must match the browser-visible host **and public port**, otherwise same-origin login checks reject every sign-in. The installer handles this, including ALB/`--public-port 443`. |

## 1. Install prerequisites

### Debian / Ubuntu

```bash
sudo apt-get update
sudo apt-get install -y curl git nginx openssl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # must be 22.5 or newer (node:sqlite)
```

### RHEL / Rocky / AlmaLinux

```bash
sudo dnf install -y git nginx openssl
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
sudo dnf install -y nodejs
node -v
```

### Amazon Linux 2023

```bash
sudo dnf install -y git nginx openssl nodejs22
node -v
# If an older node is selected:
sudo alternatives --set node /usr/bin/node-22
```

## 2. Install the console

```bash
sudo git clone https://github.com/muneeb819/Voice-Agent-Console.git /opt/vac-src
cd /opt/vac-src
sudo git checkout main
sudo git pull
sudo bash deploy/linux-deploy.sh --host <PUBLIC_IP_OR_DOMAIN>
```

The installer is safe to re-run and:

1. Installs the app to `/opt/voice-agent-console`.
2. Creates `.env` only if missing and generates a strong `ADMIN_PASSWORD`.
3. Sets `HOST=127.0.0.1`, `PORT=534`, `TRUST_PROXY=127.0.0.1`.
4. Runs `npm ci --include=dev` and `npm run build`.
5. Creates a self-signed TLS certificate with an IP/DNS SAN (unless
   `--cert`/`--key` is supplied).
6. Writes and starts `voice-agent-console.service`.
7. Writes the nginx TLS block, reloads nginx and verifies both hops.

Useful options:

```text
--host <address>        Public IP or DNS name (required; --ip is an alias)
--tls-port <port>      Public HTTPS port (default 533)
--app-port <port>      Loopback Node port (default 534)
--public-port <port>   Browser-facing port when an ALB/CDN terminates TLS
--real-ip-from <cidr>  Trust a load balancer CIDR for X-Forwarded-For (repeatable)
--cert <path>          Existing certificate
--key <path>           Matching private key
--install-dir <dir>    Install root (default /opt/voice-agent-console)
```

AWS-specific notes (security groups, ALB, Let's Encrypt IP certificates) are in
[`AWS-DEPLOYMENT.md`](./AWS-DEPLOYMENT.md). The old `deploy/aws-deploy.sh`
entry point is a compatibility wrapper around `linux-deploy.sh`.

## 3. Open the firewall

Open the TLS port in the host firewall **and** the cloud security group:

```bash
# firewalld (RHEL family)
sudo firewall-cmd --permanent --add-port=533/tcp
sudo firewall-cmd --reload
```

Do **not** open the SIP/RTP bridge ports (`5062/udp`, `9092/tcp`) to the
internet. Allow them only from the VICIdial/Asterisk host.

SELinux note: if `getenforce` returns `Enforcing`, the installer labels its TLS
directory `cert_t` so nginx can read the key. If nginx still cannot bind 533:

```bash
sudo dnf install -y policycoreutils-python-utils
sudo semanage port -a -t http_port_t -p tcp 533   # or -m if already defined
sudo setsebool -P httpd_can_network_connect 1
# Make the certificate label survive a filesystem relabel:
sudo semanage fcontext -a -t cert_t '/etc/voice-agent-console/tls(/.*)?'
sudo restorecon -R /etc/voice-agent-console/tls
sudo systemctl restart nginx
```

## 4. Verify and sign in

```bash
systemctl status voice-agent-console.service
curl -fsS http://127.0.0.1:534/api/health
curl -fsSk https://127.0.0.1:533/api/health
sudo nginx -t
journalctl -u voice-agent-console.service -f
```

Read the generated admin password:

```bash
sudo grep '^ADMIN_PASSWORD=' /opt/voice-agent-console/.env
```

Open `https://<PUBLIC_IP_OR_DOMAIN>:533/`. The default certificate is
self-signed, so browsers warn until you install a trusted certificate:

```bash
sudo bash deploy/linux-deploy.sh --host console.example.com \
  --cert /etc/letsencrypt/live/console.example.com/fullchain.pem \
  --key  /etc/letsencrypt/live/console.example.com/privkey.pem
```

## 5. SIP / VICIdial

After signing in:

1. Open **VICIdial → SIP Connection Model**.
2. Choose Static Peer, SIP Registration or Hybrid.
3. Set the public bridge host, SIP port, registrar host/port/domain and user.
4. Save `VICI_SIP_PASSWORD` under **API Keys**.
5. Set `BRIDGE_ALLOWED_IPS` to the PBX source addresses only.
6. Restart after bridge or SIP changes:

```bash
sudo systemctl restart voice-agent-console.service
```

## 6. Updates

```bash
cd /opt/vac-src
sudo git pull
sudo bash deploy/linux-deploy.sh --host <PUBLIC_IP_OR_DOMAIN>
```

Existing `.env` and certificates are preserved. Back up
`/opt/voice-agent-console/data/console.sqlite` and
`/opt/voice-agent-console/data/recordings/` before major updates.

## 7. Docker alternative

Any Linux host with Docker can run the console as an unprivileged container:

```bash
cp .env.example .env
# Set ADMIN_PASSWORD in .env before starting.
docker compose up -d --build
curl -fsS http://127.0.0.1:8080/api/health
```

The container listens on **8080** and persists SQLite, recordings and managed
secrets in the `voice-agent-data` volume (`/data`). The default host binding is
loopback-only. To expose it, put a TLS reverse proxy in front and allow the
proxy address in `TRUST_PROXY`; do not publish 8080 directly to the internet.

```bash
docker compose logs -f
docker compose down
```

## 8. Security checklist

- Use a long, unique `ADMIN_PASSWORD`; change it after first sign-in.
- Keep provider/PBX keys in the server-side `.env` or API Keys screen, never in
  browser storage.
- Restrict the console port to operator networks where possible.
- Keep SIP/RTP ports private and set `BRIDGE_ALLOWED_IPS` explicitly.
- Terminate TLS with a trusted certificate; replace self-signed defaults.
- Back up the SQLite database and recordings, and monitor `/api/health`.
