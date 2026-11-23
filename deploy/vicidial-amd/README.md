# MMA call screening: dialer side

Three scripts, run on the VICIdial/Asterisk server as root. Full design, deployment and rollback: `docs/CALL-SCREENING.md`.

| Script | Changes anything? | What it does |
|---|---|---|
| `inspect-amd.sh [context]` | No | Asterisk version, AMD module, `amd.conf`, the live 8369 dialplan, `VD_amd.agi` (path, checksum, how it treats MACHINE/NOTSURE), campaigns and their routing extension (read-only SQL), AMD statuses. Saves a report in `/tmp`. |
| `install-mma-amd.sh` | Only with `--apply` | Generates extension **8370** from the live **8369** (stock is never edited), adds one step after `AMD()` that stores HUMAN/NOTSURE results in AstDB for the bot leg, includes the file, reloads the dialplan, checks it loaded, restores the backup if not. Adds a nightly AstDB cleanup. |
| `rollback-mma-amd.sh [context]` | Yes | Refuses while a campaign still routes to 8370; otherwise removes the include, the generated file and the cleanup job, and reloads. |

```bash
sudo bash inspect-amd.sh
sudo bash install-mma-amd.sh --tuned --secret "$SCREENING_EVENT_SECRET"           # dry run, review
sudo bash install-mma-amd.sh --tuned --secret "$SCREENING_EVENT_SECRET" --apply
```

Then in VICIdial admin set the campaign's **Routing Extension** to `8370` (one campaign first), and paste the updated AI-extension dialplan from the console (it relays the AMD result to the bridge).
