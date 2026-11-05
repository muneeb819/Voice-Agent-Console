# ViciBox Co-Located Production Go-Live Runbook
**Unified Voice Agent Console + Deepgram Voice Agent API + Universal VICIdial Bridge (Step 4 Release)**

> **Legacy topology examples, not a verified deployment recipe.** The public IP addresses and dialplan values below describe an old environment and are not defaults or automatically trusted peers. Do not copy them or example credentials into production. Current installation requires Node.js 22.5+, defaults to loopback-only listeners and PBX peers, preserves an existing `.env`, and requires explicit proxy trust. Review the current [README](README.md), firewall/TLS configuration, and your own VICIdial/Asterisk setup; validate in staging before handling real calls.
>
> **Greeting behavior change:** imported greeting rotation is enabled by default for every bot. All 1,100 supplied rows, including meeting and time-specific language, can be appended after the saved opening and enabled disclosure. Review the library and each agent's complete script and factual claims before real calls. To disable this for a bot, uncheck its random-greeting setting under **Agents** and save. See the README's [greeting rotation section](README.md#imported-greetings-and-call-rotation) for logging and fallback limits.

---

## 1. Architecture Summary (Example Co-Located ViciBox)

| Component | Bind / Port | Purpose & Security |
|---|---|---|
| **Web Console, Wallboard & REST/WS API** | `127.0.0.1:533` by default | Protected by operator authentication. Direct loopback PBX hooks have a local exemption; remote peers require explicit configuration and authentication as applicable. |
| **Universal SIP + RTP (G.711 μ-law 8 kHz)** | `127.0.0.1:5062` UDP by default | Supports SIP/RTP without `app_audiosocket`. Configure `BRIDGE_BIND_HOST` and a restrictive `BRIDGE_ALLOWED_IPS` for a remote PBX; choose a port that does not collide with Asterisk. |
| **Native Asterisk 18+ AudioSocket TCP** | `115.186.137.240:9092` TCP | Native `slin` 8 kHz TCP audio framing for Asterisk 18+ (`ViciBox 11/12`). Uses `CURL(/api/vici/register-call)` returning a canonical 36-char RFC 4122 UUID. |
| **VICIdial Non-Agent & Agent HTTP APIs** | `http://115.186.137.240` | `/vicidial/non_agent_api.php` (`lead_all_info`, `update_lead`, `add_dnc_phone`) + `/agc/api.php` (`ra_call_control` `INGROUPTRANSFER`, `EXTENSIONTRANSFER`, `HANGUP`). |
| **Asterisk Manager Interface (AMI)** | `115.186.137.240:5038` | `Ping` diagnostics + `Redirect` / `Hangup` fallback for direct non-Remote-Agent channels. |
| **Stereo 8 kHz Call Recordings** | `data/recordings/*.wav` | Automatic 2-channel (`Left = Caller`, `Right = AI Bot`) WAV archive with in-browser playback and 200-call rolling retention. |

---

## 2. Step-by-Step Installation on ViciBox (5 Minutes)

### 2.1 Upload & Run the One-Command Installer
Copy `voice-agent-vicibox-release.tar.gz` to `/tmp` on your ViciBox server and run:

```bash
cd /tmp
tar -xzf voice-agent-vicibox-release.tar.gz
cd voice-agent-console
sudo bash deploy/vicibox-install.sh
```

What `vicibox-install.sh` does automatically:
1. Requires Node.js 22.5+; attempts to install Node 22 if it is missing (package availability varies by OS).
2. Copies the console & bridge into `/opt/voice-agent-console` and compiles TypeScript (`dist/`).
3. Preserves an existing `/opt/voice-agent-console/.env`, or creates one (`chmod 600`) with a generated `ADMIN_PASSWORD` and loopback-only defaults.
4. Detects your Asterisk version and whether `app_audiosocket.so` is loaded.
5. Registers and starts `voice-agent-bridge.service` under `systemd` (`Restart=always`).

### 2.2 Set Your API & ViciBox Credentials
Edit `/opt/voice-agent-console/.env` (or sign in at `http://<VICIBOX_IP>:533` and click **🔑 API Keys**):

```bash
sudo nano /opt/voice-agent-console/.env
```

Fill in:
```ini
DEEPGRAM_API_KEY=<SET_LOCALLY_DO_NOT_COMMIT>
VICI_API_PASS=your_vicidial_6666_user_password
AMI_SECRET=<YOUR_ASTERISK_AMI_SECRET>
ADMIN_PASSWORD=<YOUR_STRONG_CONSOLE_PASSWORD>
BRIDGE_ALLOWED_IPS=<YOUR_TRUSTED_PBX_IPS>
BRIDGE_BIND_HOST=<YOUR_BRIDGE_BIND_ADDRESS>
```
*(Tip: On standard ViciBox installs, check `/etc/astguiclient.conf` or `/etc/asterisk/manager.conf` under `[cron]` to confirm `AMI_SECRET`.)*

The SIP and AudioSocket bridge bind to loopback by default. To accept bridge traffic from another host, explicitly set `BRIDGE_BIND_HOST` and add only trusted peers to `BRIDGE_ALLOWED_IPS`; keep these ports closed to the public internet.

Restart if edited via CLI:
```bash
sudo systemctl restart voice-agent-bridge.service
```

### 2.3 Open Firewall Port `:533` (For Your Admin Browser Only)
Keep `:5062` (UDP) and `:9092` (TCP) closed to the public internet since Asterisk talks to them locally over `115.186.137.240`. Open `:533` TCP in ViciBox `firewalld` (ideally restricted to your office/VPN IP):

```bash
# Open :533 to your office IP (recommended) or internal zone:
sudo firewall-cmd --permanent --zone=external --add-rich-rule='rule family="ipv4" source address="YOUR_OFFICE_IP/32" port protocol="tcp" port="533" accept'
sudo firewall-cmd --reload
```

---

## 3. VICIdial Admin Configuration Checklist

Log into **VICIdial Administration (`https://<VICIBOX_IP>/vicidial/admin.php`)** and complete these 4 quick items:

### Step A — Verify API User (`6666`)
1. Go to **Users $\rightarrow$ Show Users $\rightarrow$ `6666`** (or create dedicated user `6666`).
2. Set **User Level = `8`** (or `9`), **Active = `Y`**, and under **Admin Interface / API Options** enable:
   - `Modify Leads` = `1`
   - `Agent API Access` = `1`
   - `Modify Same User Level` = `1`

### Step B — Create Closer In-Group (`FE_CLOSERS`)
1. Go to **Inbound $\rightarrow$ Show In-Groups $\rightarrow$ Add A New In-Group**:
   - **Group ID:** `FE_CLOSERS`
   - **Group Name:** `Final Expense Live Closers`
   - **Web Form / Screen-Pop:** Standard VICIdial lead screen-pop works automatically because our Bridge transfers via `ra_call_control` (`stage=INGROUPTRANSFER`), preserving the `VmmddhhmmssLLLLLLLLLL` caller tracking string and pre-saving AI qualification notes into `comments`!
2. Go to **Campaigns $\rightarrow$ Modify Campaign (`FETEST`) $\rightarrow$ Allowed Transfer Groups**:
   - Check **`FE_CLOSERS`** and click **Submit**.
3. Ensure human closer agents select **`FE_CLOSERS`** when logging into `/agc/vicidial.php`.

### Step C — Add the Local AI Bridge Carrier (`AIBRIDGE`)
Go to **Admin $\rightarrow$ Carriers $\rightarrow$ Add A New Carrier**:
- **Carrier ID:** `AIBRIDGE`
- **Carrier Name:** `Local Deepgram AI Voice Bridge`
- **Registration String:** *(leave blank)*
- **Account Entry (Option A — Universal SIP/RTP for ALL ViciBox / Asterisk 13, 16, 18+):**
```ini
[ai-bridge]
disallow=all
allow=ulaw
type=friend
host=115.186.137.240
port=5062
dtmfmode=rfc2833
context=trunkinbound
qualify=yes
insecure=port,invite
```
- **Protocol:** `SIP`
- **Globals String:** *(leave blank)*
- **Dialplan Entry (Universal SIP/RTP Mode):**
```asterisk
exten => _839X.,1,NoOp(VICIdial AI Bot SIP -> Ext ${EXTEN} | ViciCID: ${CALLERID(name)})
 same => n,SIPAddHeader(X-Vici-CallName: ${CALLERID(name)})
 same => n,SIPAddHeader(X-Vici-UniqueID: ${CHANNEL(uniqueid)})
 same => n,SIPAddHeader(X-Vici-Channel: ${CHANNEL})
 same => n,SIPAddHeader(X-Vici-Exten: ${EXTEN})
 same => n,Dial(SIP/${EXTEN}@ai-bridge,60,tTo)
 same => n,Hangup()
```
*(Alternative Option B for Asterisk 18+ AudioSocket TCP is also generated dynamically in the Console's **Dialer / Vici (Bridge)** tab.)*
- Set **Active = `Y`**, click **Submit**, wait 60 seconds for `ADMIN_keepalive_ALL.pl` to reload Asterisk, and verify with:
  ```bash
  asterisk -rx "sip show peer ai-bridge"
  ```
  You will see `Status : OK (1 ms)` because the Node SIP listener responds to `OPTIONS` keep-alives!

### Step D — Activate Remote Agent (`9001`)
1. Go to **Remote Agents $\rightarrow$ Add New Remote Agents**:
   - **User ID Start:** `9001` *(ensure user `9001` exists under Users with User Level 4 & Agent API Access = 1)*
   - **Number of Lines:** `10` *(matches Campaign `Max Concurrent Calls` in the Console)*
   - **Server IP:** *(select your ViciBox server IP)*
   - **External Extension:** `8391` *(routes to Campaign #1 in the Console; `8392` routes to Campaign #2, etc.)*
   - **Campaign ID:** `FETEST`
   - **On-Hook Agent:** `N`
   - **Status:** `ACTIVE`

---

## 4. Pre-Dial Go-Live Smoke Test (Before Turning Campaign Active)

1. Open `http://<VICIBOX_IP>:533` and sign in with `ADMIN_PASSWORD`.
2. Open **`Dialer / Vici (Bridge)`** and click **🔌 Test ViciBox HTTP & AMI**:
   - Confirm **`✓ VERSION: 2.14-...`** on `/vicidial/non_agent_api.php` and **`✓ Pong`** on Asterisk AMI `:5038`.
3. Click **📞 Simulate Full ViciBox Call** (`SIP + RTP G.711 μ-law` + `Live Deepgram Cloud`) to verify end-to-end 8 kHz audio + TTS + function execution.
4. Place **1 manual test lead** (your cell phone) into list `1001` on campaign `FETEST`, set Remote Agent `9001` to **`ACTIVE`**, answer your phone, confirm you hear the greeting + disclosure, say *"Yes, I'm 64 in Florida and want a quote"*, and verify:
   - Your closer browser logged into `FE_CLOSERS` receives the live call + lead screen-pop with AI notes in `comments`!
   - Open **`Wallboard & QA`** in the Console to listen to the stereo `.wav` recording (`Left = Caller, Right = AI Bot`) and export CSV CDRs.
