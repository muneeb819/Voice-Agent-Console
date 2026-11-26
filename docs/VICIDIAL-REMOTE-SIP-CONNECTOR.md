# VICIdial Remote SIP Connector (Static Peer, Registration, Hybrid)

This feature extends the existing Voice Agent Console bridge. It does not install Asterisk or replace the dialer's VICIdial configuration.

## Connection modes

| Mode | What the console does | What the dialer must do |
| --- | --- | --- |
| `static_peer` | Accepts SIP INVITEs on `BRIDGE_SIP_PORT`; the PBX is validated against `BRIDGE_ALLOWED_IPS`. | Configure a static SIP peer whose host is the console's public `bridgeHost` and send calls to its SIP port. |
| `registration` | Sends UDP SIP REGISTER to the configured registrar, handles a Digest MD5 challenge with `qop=auth`, and refreshes the registration before expiry. | Create a dynamic SIP peer/account, accept the REGISTER credentials, and route the peer's calls to the configured registered Contact. |
| `hybrid` | Runs the same inbound SIP/RTP listener and maintains the outbound registration concurrently. | Configure both the static peer route and the dynamic registration account. Use separate peer identities if the PBX requires them. |

AudioSocket remains available and is not removed by this SIP feature.

## Console configuration

Under **VICIdial → SIP Connection Model**:

1. Select Static SIP Peer, SIP Registration, or Hybrid.
2. Set the public Bridge Host / IP and SIP listener port.
3. For Registration or Hybrid, set registrar host, UDP port, SIP domain (if different), SIP username and optional authentication username.
4. Save `VICI_SIP_PASSWORD` under **API Keys**. It is stored server-side in the managed environment file and is never part of the exported dialplan.
5. Set `BRIDGE_ALLOWED_IPS` to the PBX signaling/media source addresses. Do not use `0.0.0.0/0`.

The registrar must be reachable over UDP from the console. The current registration client supports SIP Digest MD5 with `qop=auth`; TLS, TCP, AKA, SHA-256 digest, outbound proxy chains, and registrar-specific extensions are not implemented. Use a fixed public address or stable DNS record for the bridge Contact.

## Asterisk peer examples

The generated example is **chan_sip syntax only**. It is not a universal PJSIP configuration. Confirm the actual Asterisk channel driver and version on the dialer before applying it.

### Static peer (chan_sip)

```ini
[ai-bridge]
type=friend
host=BRIDGE_PUBLIC_IP
port=5062
context=trunkinbound
disallow=all
allow=ulaw
dtmfmode=rfc2833
qualify=yes
insecure=port,invite
```

### Registration peer (chan_sip)

Create a dynamic peer with a username and secret matching the console's SIP username and `VICI_SIP_PASSWORD`. The console registers its Contact at `sip:USERNAME@BRIDGE_PUBLIC_IP:5062;transport=udp`. The PBX must route calls to that contact/peer and preserve the VICIdial call identity in the From display name or the documented `X-Vici-CallName` header.

```ini
[ai-bridge-registered]
type=friend
host=dynamic
defaultuser=CONSOLE_SIP_USERNAME
secret=THE_SAME_SECRET_AS_VICI_SIP_PASSWORD
context=trunkinbound
disallow=all
allow=ulaw
dtmfmode=rfc2833
qualify=yes
```

### Hybrid

Configure both peer definitions. Prefer distinct peer names and explicitly decide which route handles each campaign. Avoid sending the same call down both paths.

For PJSIP, configure an endpoint, auth object, and AOR/contact using your own Asterisk version's supported syntax. Do not paste chan_sip options into `pjsip.conf`.

## Ports and network

- SIP signaling: UDP `BRIDGE_SIP_PORT` (default 5062).
- RTP media: the bridge currently allocates per-call UDP sockets dynamically. The AWS security group and host firewall must therefore be configured for the actual RTP allocation strategy; a fixed RTP range is a separate hardening task and is not implied by this registration feature.
- HTTPS management: expose only behind authenticated TLS.
- SSH: restrict to trusted administrator IPs.
- Restrict SIP and RTP ingress to the dialer/PBX media addresses. Do not expose AMI or VICIdial API credentials to the public internet.

## Important VICIdial call-control requirements

SIP registration alone does not create a VICIdial Remote Agent session. The PBX must originate/bridge the call through the configured Remote Agent route, and the console must receive the actual VICIdial remote-agent call ID. Live transfer uses the Agent API `ra_call_control` with `agent_user`, `stage=INGROUPTRANSFER`, `ingroup_choices`, and `value=<actual VICIdial call ID>`. Do not put the stage in `value`.

The dialer operator remains responsible for DID routing, campaigns, leads, carriers, Asterisk, agent users, In-Groups, queues and human-agent operations. The console owns the AI runtime and bridge configuration.

## Validation sequence

1. Save configuration and restart the console service.
2. Confirm the bridge reports the SIP listener as active.
3. For Registration/Hybrid, confirm `sipRegistration.status=registered` and that the registrar shows the expected Contact.
4. Confirm an authorized PBX OPTIONS request receives a SIP 200 response.
5. Place one isolated test call; confirm SIP INVITE, negotiated PCMU/8000 SDP, RTP in/out, correct campaign/bot mapping and clean BYE.
6. Test qualified transfer with the actual remote-agent call ID and confirm the call appears in the intended closer In-Group.
7. Test caller hangup, duplicate transfer prevention, DNC and provider failure.
8. Increase concurrency gradually only after media quality and transfer behavior are verified.

A successful REGISTER response or a passing local test is not proof of an end-to-end live VICIdial call. Do not enable production traffic until the dialer administrator has verified the actual PBX configuration and the full test sequence.

## Transfer order and the SIP REFER backup

When a bot qualifies a caller, the bridge tries to move the call in this order and stops at the first one that works:

1. VICIdial Agent API (`ra_call_control`)
2. Asterisk AMI Redirect (needs TCP 5038 open from the console server)
3. SIP REFER (backup): the bridge asks the dialer, inside the call it already holds, to send the caller to the transfer extension. It needs no extra port.
4. If all three fail, the call gets the campaign's callback disposition.

The REFER step only runs for an extension target, and can be switched off under VICIdial settings ("Backup transfer: ask the dialer over SIP (REFER) if API and AMI fail"). Every attempt is written to the VICIdial API audit log as `SIP REFER -> <extension>`.

The dialer must accept REFER on the `ai-bridge` peer. It may need `allowtransfer=yes` (chan_sip) or the equivalent, and the REFER context must be able to reach the transfer extension. This path has been unit tested but not yet exercised against a live dialer.

## Putting the bots to sleep

The Command deck has a **Sleep bots / Wake bots** button. While asleep, the bridge answers every new call with `503 "Bots asleep"` (and refuses `register-call`) before any campaign, speech or AI service is opened, so no STT, LLM or TTS usage is spent. Calls already in progress finish normally.

- API: `GET /api/bot-sleep`, `POST /api/bot-sleep {"sleeping": true|false, "endActiveCalls": true|false}` (`endActiveCalls` also hangs up calls in progress).
- The setting is stored in `data/bot-sleep.json`, not in the console state, so a stale open console tab cannot switch it back. It survives restarts.
- The bridge status shows `botSleep` and `rejectedAsleepCount`.
- Sleeping stops the bots answering; VICIdial keeps dialing. To stop dialing too, pause the campaign or the remote agents in VICIdial.

## Deepgram usage report

Deepgram bills agent time for as long as a connection stays open, not only while someone is talking. The console records the open and close time of every Deepgram agent connection it makes (phone calls and the simulator) in `data/usage-ledger.jsonl`.

- The wallboard shows a **Deepgram agent usage** card: connections and hours per UTC day, split into phone calls and simulator, the longest connection, and any connection open for 15 minutes or more right now.
- API: `GET /api/usage/report?days=7`.
- It counts from the moment this version is installed. Use it to check the total against Deepgram's own dashboard.
