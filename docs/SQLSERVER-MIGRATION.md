# SQLite → Microsoft SQL Server Migration (SSMS)

## Scope and source of truth

This plan is derived from the current repository implementation:
- `src/db.ts`: `console_store`, `state_revisions`, `greeting_library`, greeting rotation tables, `simulator_calls`, `bridge_calls`.
- `src/user-store.ts`: `users`, `user_sessions`, `revoked_admin_sessions`.
- `src/types.ts`: `ConsoleState`, Provider, AgentFunction, Agent, Campaign, ViciConfig, TestScenario.

The current application persists the canonical console configuration as one JSON document in SQLite (`console_store.active_state`) and keeps typed runtime structures inside that JSON. The SQL Server foundation therefore keeps a lossless JSON state/revision store **and** creates relational projections for agents, campaigns, providers, functions, assignments and test scenarios. This avoids losing forward-compatible fields while making reporting and later repository-level queries relational.

## SQL Server deliverable

Run `database/sqlserver/001_schema.sql` in SSMS after creating/selecting database `VAC_Console`. It targets SQL Server 2019+ and creates schema `vac`.

Objects created:
- Tables: SchemaMigrations, ConsoleStore, StateRevisions, Users, UserSessions, RevokedAdminSessions, Providers, AgentFunctions, Agents, Campaigns, CampaignAgents, GlobalServices, ViciConfiguration, TestScenarios, GreetingLibrary, GreetingRotationUsed, GreetingRotationState, SimulatorCalls, BridgeCalls.
- Indexes for user/session lookup, campaign-agent joins, call history, agent history and revision chronology.
- Procedures: SaveConsoleState, PurgeExpiredSessions, RevokeUserSessions.
- View: vw_CallHistorySummary.
- JSON constraints on JSON-backed fields, role/mode/transport checks, relational foreign keys.

## Exact source mapping

| SQLite source | SQL Server destination | Mapping notes |
|---|---|---|
| console_store | vac.ConsoleStore | Preserve key/value JSON; active_state remains canonical during compatibility phase |
| state_revisions | vac.StateRevisions | Preserve IDs where possible, timestamp, summary and exact JSON snapshot |
| users | vac.Users | Preserve IDs, normalized email, scrypt hash, timestamps, role, active flag |
| user_sessions | vac.UserSessions | Token column contains SHA-256 token hash in current code; do not export raw browser token |
| revoked_admin_sessions | vac.RevokedAdminSessions | Token hash and expiry |
| greeting_library | vac.GreetingLibrary | All five catalog fields |
| greeting_rotation_used | vac.GreetingRotationUsed | Composite agent/greeting primary key |
| greeting_rotation_state | vac.GreetingRotationState | Last greeting ID by agent |
| simulator_calls | vac.SimulatorCalls | All call metadata; transcript_json and functions_json preserved as JSON |
| bridge_calls | vac.BridgeCalls | All bridge metadata; transcript, function calls and VICIdial API audit preserved as JSON |

The following nested `ConsoleState` collections are projected from `console_store.active_state`:
- `providers[]` → Providers
- `functions[]` → AgentFunctions
- `agents[]` → Agents; behavior/STT/LLM/TTS/audio and fnIds remain valid JSON subdocuments
- `campaigns[]` → Campaigns plus CampaignAgents junction
- `services.stt/llm/tts` → GlobalServices
- `vici` → singleton ViciConfiguration row (ConfigId=1)
- `tests[agentId][]` → TestScenarios

## Data that is not in SQLite

- Deepgram, LLM, VICIdial and speech-service secrets are managed through environment/secret storage (`src/env-store.ts`), not SQLite. Do not put plaintext secrets into SQL tables or migration exports. Reconfigure secrets separately using the production secret manager.
- WAV/WebM/OGG/M4A recordings are files in the private data directory; SQL stores their filenames and metadata. Migrate the files separately, preserving access controls and verifying file hashes.
- The static GitHub Pages demo's browser IndexedDB is not the authoritative backend database.
- The Python speech service has its own runtime/job state; this first schema does not silently fold that service into the console DB.

## Migration order

1. **Backup and inventory**: stop writes for a consistent backup, copy `data/console.sqlite`, `data/console-state.json`, and private recording directories; record file hashes and counts. Do not run migration against a live, changing SQLite file.
2. **Provision SQL Server**: create `VAC_Console`; create a dedicated least-privilege SQL login/user; enable TLS; restrict network access; configure encrypted backups and point-in-time recovery.
3. **Create schema**: run `001_schema.sql`; verify every object exists and the migration marker is recorded.
4. **Extract SQLite**: export each source table and the current active_state JSON with exact row counts. Treat export files as sensitive: they include password hashes, session hashes, phone/lead metadata, and potentially call transcripts.
5. **Load in dependency order**: users → sessions/revocations; greeting catalog → agents/providers/functions → campaigns/assignments/services/config/tests; state store/revisions; call history. Keep original IDs and UTC offsets. Do not convert local timestamps without preserving their offset.
6. **Project nested state**: parse active_state and populate typed tables in one transaction. Keep the original JSON byte-for-byte in ConsoleStore as a recovery source.
7. **Verify**: compare per-table row counts; compare IDs and aggregate durations/bytes; compare JSON hashes for state snapshots and call payloads; verify all foreign keys; verify password login and session revocation in a non-production test environment.
8. **Application adapter**: implement a repository interface behind existing `src/db.ts` and `src/user-store.ts`; keep SQLite as default until SQL Server passes parity tests. Add explicit `VAC_DB_PROVIDER=sqlserver` selection, connection pooling, parameterized queries, transaction boundaries and retry rules. Do not use a naive SQL text substitution layer.
9. **Shadow-read / controlled cutover**: mirror writes or shadow-read only after parity tests; compare results; schedule a short write freeze; take final backup; cut over; retain SQLite read-only for rollback.
10. **Rollback**: if verification fails, stop the SQL Server writer, restore the SQLite backup and restart with SQLite provider. Never run two independent writable primaries.

## Important behavioral differences to handle in the adapter

- SQLite `INSERT OR REPLACE`, `ON CONFLICT`, `RANDOM()`, `LIMIT`, `lastInsertRowid`, and `BEGIN IMMEDIATE` are not T-SQL equivalents. Implement explicit MERGE/UPDATE+INSERT patterns, `TOP`/OFFSET, `NEWID()` sampling, `SCOPE_IDENTITY()`, and appropriate SQL Server transaction isolation/locking.
- SQL Server `datetimeoffset` is used to preserve the app's ISO timestamps. Convert to/from ISO-8601 at the repository boundary.
- SQLite booleans are integer 0/1; SQL Server uses bit.
- SQLite text JSON is stored in nvarchar(max) with ISJSON constraints.
- SQLite `COLLATE NOCASE` email uniqueness becomes a case-insensitive collation or normalized lower-case unique index; ensure the target database collation is understood.
- Session tokens are hashed before storage. Preserve the current hashing behavior and do not migrate raw tokens.
- The current app prunes state revisions to 50 and call histories according to existing retention logic. Preserve those behaviors until an explicit retention policy is approved.
- SQL Server must not be used as a dumping ground for provider credentials or raw recording binaries. Store recordings in private object/file storage and keep metadata in SQL.

## Current status

**Foundation only — not cut over.** The SQL Server DDL and this migration runbook are committed on a feature branch. The Node application still uses SQLite. No SQL Server instance, credentials, network endpoint, or test database was supplied, so schema execution, data loading, app adapter parity, and performance testing remain pending. No production data has been changed.
