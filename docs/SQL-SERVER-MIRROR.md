# SQL Server database (AWS RDS · SSMS)

The console keeps running on its own built-in database (SQLite). The **SQL Server mirror** copies everything to your SQL Server on AWS RDS a few seconds after it changes, so you can browse, query and report on it in **SQL Server Management Studio (SSMS)**.

Why a mirror and not a full switch: a live call reads and writes the database many times. Those calls stay on the local database, so an RDS outage, a slow network or maintenance on RDS never affects a call. While RDS is unreachable, changes wait in a queue and arrive when it comes back.

## What is copied

| SQL Server table | What it holds |
|---|---|
| `vac.console_store` | All bots, campaigns, providers and settings (the console state, as JSON) |
| `vac.state_revisions` | Every saved version of the settings |
| `vac.bridge_calls` | Every live VICIdial call: campaign, bot, phone, disposition, transfer, transcript, function calls |
| `vac.simulator_calls` | Every test call made in the console |
| `vac.screening_results`, `vac.screening_settings`, `vac.screening_test_runs` | Call screening (answering machine detection) decisions and tests |
| `vac.greeting_library` | Opening lines |
| `vac.voice_clone_consents` | Voice clone consent records |
| `vac.users` | Console accounts: name, email, role, last login |

Each table also gets `_mirrored_at`: when the row last reached SQL Server (UTC).

**Never copied:** password hashes, login sessions, revoked tokens, and internal rotation cursors. Any column whose name contains *password, hash, secret, token* or *salt* is skipped. New tables and new columns are picked up automatically.

Reporting views with real date/time columns (SQLite stores dates as text):

- `vac.v_bridge_calls`: `started_at_utc`, `ended_at_utc`, `duration_sec`
- `vac.v_simulator_calls`
- `vac.v_screening_results`: `decided_sec`, `created_at_utc`

## Set up (one time)

### 1. AWS: let the console server reach RDS

In the AWS console → **RDS** → your SQL Server instance → **Connectivity & security**:

1. Copy the **Endpoint** (for example `mydb.abc123.ap-southeast-2.rds.amazonaws.com`) and the **Port** (1433).
2. Open the instance's **VPC security group** → **Inbound rules** → **Add rule**:
   - Type **MSSQL** (TCP 1433). Source: the console server only. If the EC2 server is in the same VPC, choose the EC2 server's **security group**. Otherwise use the EC2 public IP `/32`.
   - To use SSMS from your own PC, add one more MSSQL rule with **My IP**. The instance must have **Publicly accessible = Yes** for that.
   - Never use `0.0.0.0/0` for port 1433.

### 2. Console: connect and switch on

Sign in as owner or admin → **Export** tab → **SQL Server database (AWS RDS · SSMS)** card:

1. Fill in **RDS endpoint**, **Port**, **Database** (default `VoiceAgentConsole`), **Schema** (default `vac`), **Username** (the RDS master user, or a login you created) and **Password**.
2. Click **1. Save & test connection**. If the database does not exist yet, it is created. The password is stored in the server's `.env` file, never in the database, and is never shown again.
3. Click **2. Turn mirror on**. The first full copy starts within a few seconds; the table list shows each table's progress.

**Verify the RDS certificate** stays ticked. On the first connection the server downloads the AWS RDS certificate bundle from `truststore.pki.rds.amazonaws.com` into its data folder and checks the RDS certificate against it. The connection is always encrypted.

**Keep rows when deleted in the console (archive):** tick this if SQL Server should keep call logs after the console deletes them (for example after "Clear call logs").

**Copy everything again:** sends every table again. Use it after restoring SQL Server or if you changed rows there by hand. The mirror does this by itself when you point it at a different server or database.

### 3. SSMS: open it

**Connect → Database Engine**:

- **Server name:** `your-endpoint.rds.amazonaws.com,1433` (comma, not colon)
- **Authentication:** SQL Server Authentication
- **Login / Password:** your RDS user
- **Encryption:** Mandatory. If SSMS says the certificate chain is not trusted, either tick **Trust server certificate** or install the AWS RDS root certificate on your PC.

Then open **Databases → VoiceAgentConsole → Tables → vac.\*** and **Views**.

## Useful queries

```sql
-- Today's live calls by disposition
SELECT disposition, COUNT(*) AS calls, AVG(duration_sec) AS avg_sec
FROM vac.v_bridge_calls
WHERE started_at_utc >= CAST(SYSUTCDATETIME() AS DATE)
GROUP BY disposition ORDER BY calls DESC;

-- Transfers per campaign, last 7 days
SELECT vici_campaign, COUNT(*) AS calls,
       SUM(CASE WHEN transferred_to IS NOT NULL THEN 1 ELSE 0 END) AS transfers
FROM vac.v_bridge_calls
WHERE started_at_utc >= DATEADD(DAY, -7, SYSUTCDATETIME())
GROUP BY vici_campaign;

-- Call screening outcomes, last 24 hours
SELECT outcome, COUNT(*) AS calls, AVG(decided_sec) AS avg_decision_sec
FROM vac.v_screening_results
WHERE created_at_utc >= DATEADD(HOUR, -24, SYSUTCDATETIME())
GROUP BY outcome;

-- One call's transcript (JSON)
SELECT j.[role], j.content, j.ts
FROM vac.bridge_calls c
CROSS APPLY OPENJSON(c.transcript_json) WITH ([role] NVARCHAR(20), content NVARCHAR(MAX), ts NVARCHAR(40)) j
WHERE c.id = N'<call id>';

-- Every bot and campaign, from the settings JSON
SELECT a.id, a.name
FROM vac.console_store s
CROSS APPLY OPENJSON(s.value, '$.agents') WITH (id NVARCHAR(100) '$.id', name NVARCHAR(200) '$.name') a
WHERE s.[key] = N'active_state';

SELECT c.id, c.name
FROM vac.console_store s
CROSS APPLY OPENJSON(s.value, '$.campaigns') WITH (id NVARCHAR(100) '$.id', name NVARCHAR(200) '$.name') c
WHERE s.[key] = N'active_state';
```

Treat the `vac` tables as **read-only**. The console overwrites them on the next change or full copy. Put your own tables in a different schema.

## Troubleshooting

| Message on the card | Fix |
|---|---|
| *cannot reach the RDS endpoint* | Security group rule from step 1 is missing, or the endpoint/port is wrong. From the server: `nc -vz <endpoint> 1433`. |
| *Login failed* | Wrong username or password. Re-enter the password and save. |
| *certificate …* | Use the RDS **endpoint name**, not an IP address. |
| *Could not download the AWS RDS certificate bundle* | The server has no internet access. Download `https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem`, save it as `data/rds-global-bundle.pem` (or set `MSSQL_CA_FILE` in `.env`). |
| *CREATE DATABASE permission denied* | Create the database in SSMS first, or use the RDS master user. |
| Changes waiting keeps growing | RDS is unreachable or slow. Nothing is lost. If more than 100,000 changes queue up, the mirror makes one full copy instead. |

## How it works (for developers)

- `src/mirror/source.ts`: SQLite triggers (`mirror_<table>_ai/au/ad`) write the changed row's key to `mirror_outbox`. They exist only while the mirror is on.
- `src/mirror/engine.ts`: every few seconds, reads the queue, reads each row's **current** values and sends them in one SQL Server transaction per table (delete + insert by key). It deletes keys that no longer exist and removes the sent queue entries only after the commit. A lease row makes sure only one process syncs.
- `src/mirror/target.ts`: SQL Server via the `mssql` (tedious) driver. Always encrypted; all values are typed parameters.
- `src/mirror/sql.ts`: T-SQL text. Identifiers must match `^[A-Za-z_][A-Za-z0-9_]{0,63}$` and are bracket-quoted.
- API (owner/admin only): `GET /api/mirror/status`, `POST /api/mirror/settings`, `/test`, `/toggle`, `/resync`.
- Tests: `tests/sql-mirror-verify.ts`.
