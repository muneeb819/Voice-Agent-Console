# Publishing the Console on AWS EC2

Target in this release: **`https://3.107.192.118:533/`**

> **Status: prepared, not deployed.** The build sandbox has no SSH key or AWS
> credentials for this instance, and outbound traffic to `3.107.192.118:533` is
> blocked by the sandbox network policy (TCP connects, then TLS and HTTP are both
> reset). Nothing in this repository has been pushed to that host, and no claim
> is made that it is running there. Run the steps below on the instance, or from
> a machine that can reach it, to actually publish.

---

## 1. Topology

The Node server speaks **plain HTTP only** (`src/server.ts` uses
`http.createServer`), so HTTPS must be terminated in front of it:

```
browser ──TLS──> nginx :533 (0.0.0.0) ──HTTP──> Node 127.0.0.1:534
```

Node stays on loopback. Only nginx is exposed to the internet.

Two settings make this work, and both are easy to get wrong:

| Setting | Why it matters |
|---|---|
| `TRUST_PROXY=127.0.0.1` | The app derives `Secure` session cookies and the client IP from `X-Forwarded-*`, but only from a proxy it is told to trust. Without it, cookies are issued without `Secure` and every client looks like the proxy. Set it to the proxy address only — never `true` or `0.0.0.0/0`. |
| `X-Forwarded-Host $host:$server_port` | The same-origin check compares the browser `Origin` against the forwarded host. On a non-default port such as 533 the port **must** be included, or every login is rejected as cross-origin. |

This header set was verified end-to-end against a local TLS proxy: login
returned `200`, the session cookie carried `Secure`, an authenticated request
returned `200`, and a login with a foreign `Origin` was still rejected `403`.

## 2. Prerequisites

- An EC2 instance you can reach over SSH, running a systemd Linux (Ubuntu 22.04+
  or Amazon Linux 2023).
- **Node.js 22.5+** — the app uses the built-in `node:sqlite`.
- `nginx` and `openssl` (the script installs them if missing).
- In the instance's **security group**, an inbound rule for TCP `533`. Restrict
  the source to the operator networks that need access; do not use
  `0.0.0.0/0` for an admin console.
- Root or `sudo` on the instance.

The deploy script does **not** modify AWS networking. Security-group and NACL
changes are yours to make in the AWS console or CLI.

## 3. Deploy

Get the code onto the instance (a git clone is simplest for a public checkout;
for a private repo use a deploy key or upload a release tarball):

```bash
git clone https://github.com/muneeb819/Voice-Agent-Console.git
cd Voice-Agent-Console
sudo bash deploy/aws-deploy.sh --ip 3.107.192.118
```

The script is safe to re-run. It:

1. Checks Node ≥ 22.5 and installs nginx/openssl if absent.
2. Copies the app to `/opt/voice-agent-console`.
3. Creates `.env` **only if missing**, generating an admin password with
   `openssl rand -hex 24` and never printing it. An existing `.env` is preserved.
4. Pins `HOST=127.0.0.1`, `PORT=534`, `TRUST_PROXY=127.0.0.1`.
5. Runs `npm ci --include=dev` and `npm run build`.
6. Creates a self-signed certificate with an **IP SAN** for the address.
7. Installs and starts `voice-agent-console.service`, writes the nginx TLS
   server block, reloads nginx, and verifies `/api/health` on both hops.

Options: `--tls-port`, `--app-port`, `--install-dir`, `--cert`, `--key`, `--help`.

## 4. The certificate problem (read this)

`https://3.107.192.118:533/` is a **bare IP address**. Let's Encrypt does not
issue certificates for IP addresses, so a self-signed certificate is the only
option that works on that exact URL — and **every browser will show a security
warning**. That is expected, not a deployment failure.

To get a trusted certificate, pick one:

- **DNS + Application Load Balancer** — point a hostname at an ALB with an ACM
  certificate, target the instance on 533. ACM certificates are free and
  auto-renewed.
- **DNS + CloudFront** in front of the instance, same idea.
- **DNS + Let's Encrypt** on the instance itself, then re-run with
  `--cert /path/fullchain.pem --key /path/privkey.pem`.

Until then, operators must click through the warning, which is not appropriate
for a production console handling call data.

## 5. Verify

On the instance:

```bash
systemctl status voice-agent-console.service
curl -fsS http://127.0.0.1:534/api/health
curl -fsSk https://127.0.0.1:533/api/health
sudo nginx -t
journalctl -u voice-agent-console.service -f
```

From your workstation:

```bash
curl -kI https://3.107.192.118:533/
```

If that hangs, the security group is not open — the app cannot fix that from
inside the instance.

Read the generated admin password:

```bash
sudo grep '^ADMIN_PASSWORD=' /opt/voice-agent-console/.env
```

Sign in, then change it. Add provider keys in **Plug-Ins**; they are stored
server-side, never in browser localStorage.

## 6. Before real calls

This publishes the **web console**. It does not certify a working telephony
deployment.

- Keep the SIP/RTP bridge ports (`5062/udp`, `9092/tcp`) **closed** to the
  internet. Set `BRIDGE_ALLOWED_IPS` to your PBX addresses only.
- VICIdial/Asterisk integration is still paused pending the servers; see
  `VICIBOX-PRODUCTION-RUNBOOK.md`, whose example IPs and dialplan are historical,
  not defaults.
- Replace the self-signed certificate (section 4).
- Known gaps carried in the backend audit remain open: process-local rate
  limiting, no CSRF token (same-origin checks only), no MFA, no breach
  screening, and no per-user data isolation. Review
  `docs/security/BACKEND-AUDIT-2026-11-09.md` before exposing this broadly.
- Set up backups for `data/console.sqlite` and `data/recordings/`, plus
  alerting on the health endpoint.

## 7. Updating an existing deployment

```bash
cd Voice-Agent-Console && git pull
sudo bash deploy/aws-deploy.sh --ip 3.107.192.118
```

`.env`, the database, recordings and the TLS certificate are all preserved.
The service restarts, so active calls drop — update outside calling hours.

## 8. Rollback

```bash
sudo systemctl stop voice-agent-console.service
cd Voice-Agent-Console && git checkout <previous-tag>
sudo bash deploy/aws-deploy.sh --ip 3.107.192.118
```

Database migrations are additive; take a copy of `data/console.sqlite` before
updating if you need a guaranteed data rollback.
