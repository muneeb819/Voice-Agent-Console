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
| `X-Forwarded-Host $host:<public-port>` | The same-origin check compares the browser `Origin` against the forwarded host. On a non-default port such as 533 the port **must** be included, or every login is rejected as cross-origin. It must be the port the **browser** uses — see the ALB warning in section 4. |

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
  `0.0.0.0/0` for an admin console. If you later put a load balancer in front
  (section 4), add a second inbound rule for TCP `533` whose source is the
  **load balancer's security group** — ALB target connections come from the
  ALB, not from the operator, so an operator-only rule leaves the target
  unhealthy.
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

Options: `--tls-port`, `--app-port`, `--public-port`, `--real-ip-from`,
`--install-dir`, `--cert`, `--key`, `--help`. Ports are validated as integers in 1–65535, and `--ip` accepts
a hostname as well as an IPv4/IPv6 address (the certificate gets a `DNS:` or
`IP:` SAN accordingly).

## 4. Certificates and load balancers

### A trusted certificate for a bare IP **is** possible

Let's Encrypt has issued publicly trusted **IP-address certificates** (IPv4 and
IPv6) since [15 January 2026](https://letsencrypt.org/2026-01-15/6day-and-ip-general-availability).
So `https://3.107.192.118:533/` does not have to stay self-signed.

The constraints that matter here:

- IP certificates **must** use the `shortlived` ACME profile. They are valid for
  **160 hours (~6 days)**, so renewal has to be fully automated — a manual
  renewal cycle will break the site every week.
- Validation must use **HTTP-01 (port 80)** or **TLS-ALPN-01 (port 443)**. Both
  support IP addresses; DNS-01 does **not**. Neither challenge can run on port
  533, so you must open 80 or 443 for validation even though the console is
  served on 533.
- Your ACME client must support profile selection. Certbot has
  [supported this since March 2026](https://letsencrypt.org/2026-03-11/shorter-certs-certbot).

Once issued, install it with:

```bash
sudo bash deploy/aws-deploy.sh --ip 3.107.192.118 \
  --cert /etc/letsencrypt/live/<name>/fullchain.pem \
  --key  /etc/letsencrypt/live/<name>/privkey.pem
```

Re-run that after each renewal (or wire it into a certbot deploy hook) so nginx
picks up the new certificate.

Until you do, the script's default self-signed certificate works but **every
browser shows a warning**, which is not appropriate for a production console
handling call data.

### Alternatives

- **DNS + Application Load Balancer** with an ACM certificate (free,
  auto-renewed), targeting the instance on 533. The target group **must use
  HTTPS**, and so must its health check: nginx's `:533` listener is TLS-only,
  while AWS defaults both target traffic and health checks to HTTP. Leave the
  defaults and the target fails its health check and never serves.
- **DNS + CloudFront** in front of the instance.

### ⚠️ If you put an ALB on 443 in front of nginx on 533

The browser origin becomes `https://hostname` (no port), but nginx would
advertise `hostname:533` if it forwarded its own `$server_port`. The same-origin
check then rejects **every login**. Tell the script the browser-facing port:

```bash
sudo bash deploy/aws-deploy.sh --ip console.example.com \
  --tls-port 533 --public-port 443 \
  --cert /path/fullchain.pem --key /path/privkey.pem
```

`--public-port 443` makes nginx send `X-Forwarded-Host: $host` with no port,
matching the browser. Remember the ALB security-group rule from section 2.

**Also restore the real client IP.** Behind an ALB, nginx sees the balancer's
address, so Node rate-limits every operator against that one shared IP. The
sign-in limits are 5 failed attempts per IP+account per 15 minutes, and 30
sign-in requests per IP per minute — so a few operators sharing the balancer
address can exhaust both and lock each other out. Tell nginx which networks may
supply the client IP:

```bash
sudo bash deploy/aws-deploy.sh --ip console.example.com \
  --tls-port 533 --public-port 443 \
  --real-ip-from 10.0.0.0/16 --real-ip-from 172.31.0.0/20 \
  --cert /path/fullchain.pem --key /path/privkey.pem
```

Use the VPC/subnet CIDRs your ALB runs in (ALB addresses are dynamic, so a single
IP will not stay valid). This writes `set_real_ip_from` / `real_ip_header
X-Forwarded-For` / `real_ip_recursive on`, so the client IP is accepted **only**
from those CIDRs — never from arbitrary peers. Values are validated as real
addresses/CIDRs (so `192.0.2.1/33` is rejected, not just malformed characters),
the file is replaced atomically, and if `nginx -t` then fails the previous
working configuration is restored. The setting is preserved on re-runs that
omit the flag. `TRUST_PROXY` stays `127.0.0.1`: nginx has already
resolved the real client, so Node must trust only nginx.

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
- Replace the self-signed certificate (section 4); IP certificates are
  available but expire in ~6 days, so verify the renewal automation actually
  runs before relying on it.
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
