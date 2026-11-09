/*
  MMA Digital Labs — Voice Agent Console
  SQL Server schema baseline, derived from src/db.ts, src/user-store.ts and src/types.ts.
  Target: SQL Server 2019+ (compatibility level 150+).
  Run in SSMS against an empty database named VAC_Console.
  This script is idempotent for tables/indexes/procedures. It does not drop data.
*/
SET NOCOUNT ON;
SET XACT_ABORT ON;
GO

IF DB_NAME() <> N'VAC_Console'
  THROW 51000, 'Select the VAC_Console database before running this script.', 1;
GO

IF SCHEMA_ID(N'vac') IS NULL EXEC(N'CREATE SCHEMA vac AUTHORIZATION dbo');
GO

IF OBJECT_ID(N'vac.SchemaMigrations', N'U') IS NULL
CREATE TABLE vac.SchemaMigrations (
  MigrationId nvarchar(120) NOT NULL CONSTRAINT PK_SchemaMigrations PRIMARY KEY,
  AppliedAt datetime2(3) NOT NULL CONSTRAINT DF_SchemaMigrations_AppliedAt DEFAULT SYSUTCDATETIME(),
  Checksum char(64) NULL,
  Description nvarchar(500) NOT NULL
);
GO

/* SQLite console_store: canonical active state is JSON today. Preserve it losslessly. */
IF OBJECT_ID(N'vac.ConsoleStore', N'U') IS NULL
CREATE TABLE vac.ConsoleStore (
  [Key] nvarchar(200) NOT NULL CONSTRAINT PK_ConsoleStore PRIMARY KEY,
  [Value] nvarchar(max) NOT NULL,
  UpdatedAt datetimeoffset(3) NOT NULL,
  CONSTRAINT CK_ConsoleStore_ValueJson CHECK (ISJSON([Value]) = 1)
);
GO

IF OBJECT_ID(N'vac.StateRevisions', N'U') IS NULL
CREATE TABLE vac.StateRevisions (
  RevisionId bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_StateRevisions PRIMARY KEY,
  SavedAt datetimeoffset(3) NOT NULL,
  Summary nvarchar(2000) NOT NULL,
  Snapshot nvarchar(max) NOT NULL,
  SourceRevisionId bigint NULL,
  CONSTRAINT CK_StateRevisions_SnapshotJson CHECK (ISJSON(Snapshot) = 1)
);
GO
CREATE INDEX IX_StateRevisions_SavedAt ON vac.StateRevisions(SavedAt DESC, RevisionId DESC);
GO

/* Users: password_hash remains the existing scrypt encoded string. Never store plaintext. */
IF OBJECT_ID(N'vac.Users', N'U') IS NULL
CREATE TABLE vac.Users (
  UserId nvarchar(128) NOT NULL CONSTRAINT PK_Users PRIMARY KEY,
  Email nvarchar(254) NOT NULL,
  FullName nvarchar(80) NOT NULL,
  PasswordHash nvarchar(300) NOT NULL,
  CreatedAt datetimeoffset(3) NOT NULL,
  LastLoginAt datetimeoffset(3) NULL,
  [Role] nvarchar(16) NOT NULL CONSTRAINT DF_Users_Role DEFAULT N'operator',
  IsActive bit NOT NULL CONSTRAINT DF_Users_IsActive DEFAULT 1,
  CONSTRAINT CK_Users_Role CHECK ([Role] IN (N'owner',N'admin',N'operator',N'qa',N'viewer'))
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'vac.Users') AND name=N'UX_Users_Email')
  CREATE UNIQUE INDEX UX_Users_Email ON vac.Users(Email);
GO

/* Store only SHA-256 hashes of bearer session tokens, matching user-store.ts. */
IF OBJECT_ID(N'vac.UserSessions', N'U') IS NULL
CREATE TABLE vac.UserSessions (
  TokenHash char(64) NOT NULL CONSTRAINT PK_UserSessions PRIMARY KEY,
  UserId nvarchar(128) NOT NULL,
  CreatedAt datetimeoffset(3) NOT NULL,
  ExpiresAt datetimeoffset(3) NOT NULL,
  CONSTRAINT FK_UserSessions_Users FOREIGN KEY(UserId) REFERENCES vac.Users(UserId) ON DELETE CASCADE
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'vac.UserSessions') AND name=N'IX_UserSessions_User')
  CREATE INDEX IX_UserSessions_User ON vac.UserSessions(UserId);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'vac.UserSessions') AND name=N'IX_UserSessions_Expiry')
  CREATE INDEX IX_UserSessions_Expiry ON vac.UserSessions(ExpiresAt);
GO

IF OBJECT_ID(N'vac.RevokedAdminSessions', N'U') IS NULL
CREATE TABLE vac.RevokedAdminSessions (
  TokenHash char(64) NOT NULL CONSTRAINT PK_RevokedAdminSessions PRIMARY KEY,
  ExpiresAt datetimeoffset(3) NOT NULL
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'vac.RevokedAdminSessions') AND name=N'IX_RevokedAdminSessions_Expiry')
  CREATE INDEX IX_RevokedAdminSessions_Expiry ON vac.RevokedAdminSessions(ExpiresAt);
GO

/* Typed relational projections of ConsoleState; JSON columns retain forward-compatible nested settings. */
IF OBJECT_ID(N'vac.Providers', N'U') IS NULL
CREATE TABLE vac.Providers (
  ProviderId nvarchar(128) NOT NULL CONSTRAINT PK_Providers PRIMARY KEY,
  Kind nvarchar(8) NOT NULL,
  [Name] nvarchar(200) NOT NULL,
  ProviderType nvarchar(80) NOT NULL,
  Models nvarchar(max) NOT NULL,
  Endpoint nvarchar(2048) NOT NULL CONSTRAINT DF_Providers_Endpoint DEFAULT N'',
  HeadersJson nvarchar(max) NOT NULL CONSTRAINT DF_Providers_Headers DEFAULT N'{}',
  ExtraJson nvarchar(max) NOT NULL CONSTRAINT DF_Providers_Extra DEFAULT N'{}',
  ModelKey nvarchar(16) NOT NULL,
  CONSTRAINT CK_Providers_Kind CHECK (Kind IN (N'stt',N'llm',N'tts')),
  CONSTRAINT CK_Providers_HeadersJson CHECK (ISJSON(HeadersJson)=1),
  CONSTRAINT CK_Providers_ExtraJson CHECK (ISJSON(ExtraJson)=1)
);
GO

IF OBJECT_ID(N'vac.AgentFunctions', N'U') IS NULL
CREATE TABLE vac.AgentFunctions (
  FunctionId nvarchar(128) NOT NULL CONSTRAINT PK_AgentFunctions PRIMARY KEY,
  [Name] nvarchar(200) NOT NULL,
  [Description] nvarchar(max) NOT NULL,
  ParametersJson nvarchar(max) NOT NULL,
  IsDeferred bit NOT NULL,
  Url nvarchar(2048) NOT NULL,
  HttpMethod nvarchar(8) NOT NULL,
  HeadersJson nvarchar(max) NOT NULL,
  CONSTRAINT CK_AgentFunctions_Params CHECK (ISJSON(ParametersJson)=1),
  CONSTRAINT CK_AgentFunctions_Headers CHECK (ISJSON(HeadersJson)=1),
  CONSTRAINT CK_AgentFunctions_Method CHECK (HttpMethod IN (N'get',N'post'))
);
GO

IF OBJECT_ID(N'vac.Agents', N'U') IS NULL
CREATE TABLE vac.Agents (
  AgentId nvarchar(128) NOT NULL CONSTRAINT PK_Agents PRIMARY KEY,
  [Name] nvarchar(200) NOT NULL,
  [Mode] nvarchar(16) NOT NULL,
  [Language] nvarchar(32) NOT NULL,
  Greeting nvarchar(max) NOT NULL,
  RandomGreetingEnabled bit NOT NULL,
  Prompt nvarchar(max) NOT NULL,
  AcceptViciCalls bit NOT NULL,
  InjectCampaignDisclosure bit NOT NULL,
  BehaviorJson nvarchar(max) NOT NULL,
  SttJson nvarchar(max) NOT NULL,
  LlmJson nvarchar(max) NOT NULL,
  TtsJson nvarchar(max) NOT NULL,
  AudioJson nvarchar(max) NOT NULL,
  FunctionIdsJson nvarchar(max) NOT NULL,
  CONSTRAINT CK_Agents_Mode CHECK ([Mode] IN (N'outbound',N'inbound',N'both')),
  CONSTRAINT CK_Agents_Behavior CHECK (ISJSON(BehaviorJson)=1),
  CONSTRAINT CK_Agents_Stt CHECK (ISJSON(SttJson)=1),
  CONSTRAINT CK_Agents_Llm CHECK (ISJSON(LlmJson)=1),
  CONSTRAINT CK_Agents_Tts CHECK (ISJSON(TtsJson)=1),
  CONSTRAINT CK_Agents_Audio CHECK (ISJSON(AudioJson)=1),
  CONSTRAINT CK_Agents_FunctionIds CHECK (ISJSON(FunctionIdsJson)=1)
);
GO

IF OBJECT_ID(N'vac.Campaigns', N'U') IS NULL
CREATE TABLE vac.Campaigns (
  CampaignId nvarchar(128) NOT NULL CONSTRAINT PK_Campaigns PRIMARY KEY,
  [Name] nvarchar(200) NOT NULL,
  PrimaryAgentId nvarchar(128) NULL,
  ViciCampaign nvarchar(128) NOT NULL,
  Lists nvarchar(1000) NOT NULL,
  StartTime char(5) NOT NULL,
  EndTime char(5) NOT NULL,
  TimeZone nvarchar(100) NOT NULL,
  Attempts int NOT NULL,
  RetryMinutes int NOT NULL,
  MaxCalls int NOT NULL,
  TransferType nvarchar(16) NOT NULL,
  TransferTarget nvarchar(256) NOT NULL,
  Fallback nvarchar(500) NOT NULL,
  DncEnabled bit NOT NULL,
  Disclosure nvarchar(max) NOT NULL,
  Dispositions nvarchar(1000) NOT NULL,
  ComplianceRules nvarchar(max) NOT NULL,
  CONSTRAINT FK_Campaigns_PrimaryAgent FOREIGN KEY(PrimaryAgentId) REFERENCES vac.Agents(AgentId),
  CONSTRAINT CK_Campaigns_TransferType CHECK (TransferType IN (N'ingroup',N'extension',N'number'))
);
GO

IF OBJECT_ID(N'vac.CampaignAgents', N'U') IS NULL
CREATE TABLE vac.CampaignAgents (
  CampaignId nvarchar(128) NOT NULL,
  AgentId nvarchar(128) NOT NULL,
  IsPrimary bit NOT NULL CONSTRAINT DF_CampaignAgents_IsPrimary DEFAULT 0,
  CONSTRAINT PK_CampaignAgents PRIMARY KEY(CampaignId,AgentId),
  CONSTRAINT FK_CampaignAgents_Campaign FOREIGN KEY(CampaignId) REFERENCES vac.Campaigns(CampaignId) ON DELETE CASCADE,
  CONSTRAINT FK_CampaignAgents_Agent FOREIGN KEY(AgentId) REFERENCES vac.Agents(AgentId)
);
GO
CREATE INDEX IX_CampaignAgents_Agent ON vac.CampaignAgents(AgentId);
GO

IF OBJECT_ID(N'vac.GlobalServices', N'U') IS NULL
CREATE TABLE vac.GlobalServices (
  ServiceKind nvarchar(8) NOT NULL CONSTRAINT PK_GlobalServices PRIMARY KEY,
  ProviderId nvarchar(128) NOT NULL,
  Model nvarchar(200) NOT NULL,
  CONSTRAINT CK_GlobalServices_Kind CHECK (ServiceKind IN (N'stt',N'llm',N'tts')),
  CONSTRAINT FK_GlobalServices_Provider FOREIGN KEY(ProviderId) REFERENCES vac.Providers(ProviderId)
);
GO

IF OBJECT_ID(N'vac.ViciConfiguration', N'U') IS NULL
CREATE TABLE vac.ViciConfiguration (
  ConfigId tinyint NOT NULL CONSTRAINT PK_ViciConfiguration PRIMARY KEY,
  ConfigJson nvarchar(max) NOT NULL,
  CONSTRAINT CK_ViciConfiguration_Singleton CHECK (ConfigId=1),
  CONSTRAINT CK_ViciConfiguration_Json CHECK (ISJSON(ConfigJson)=1)
);
GO

IF OBJECT_ID(N'vac.TestScenarios', N'U') IS NULL
CREATE TABLE vac.TestScenarios (
  ScenarioId nvarchar(128) NOT NULL CONSTRAINT PK_TestScenarios PRIMARY KEY,
  AgentId nvarchar(128) NOT NULL,
  ScenarioText nvarchar(max) NOT NULL,
  ExpectedBehavior nvarchar(max) NOT NULL,
  ResultCode char(2) NOT NULL,
  Notes nvarchar(max) NOT NULL,
  CONSTRAINT FK_TestScenarios_Agent FOREIGN KEY(AgentId) REFERENCES vac.Agents(AgentId),
  CONSTRAINT CK_TestScenarios_Result CHECK (ResultCode IN (N'p',N'ok',N'f'))
);
GO
CREATE INDEX IX_TestScenarios_Agent ON vac.TestScenarios(AgentId);
GO

/* Bundled 1,100-row greeting library and per-agent non-repeat rotation state. */
IF OBJECT_ID(N'vac.GreetingLibrary', N'U') IS NULL
CREATE TABLE vac.GreetingLibrary (
  GreetingId nvarchar(128) NOT NULL CONSTRAINT PK_GreetingLibrary PRIMARY KEY,
  Persona nvarchar(200) NOT NULL,
  [Context] nvarchar(500) NOT NULL,
  GreetingText nvarchar(max) NOT NULL,
  Tone nvarchar(120) NOT NULL
);
GO
IF OBJECT_ID(N'vac.GreetingRotationUsed', N'U') IS NULL
CREATE TABLE vac.GreetingRotationUsed (
  AgentId nvarchar(128) NOT NULL,
  GreetingId nvarchar(128) NOT NULL,
  UsedAt datetimeoffset(3) NOT NULL CONSTRAINT DF_GreetingRotationUsed_UsedAt DEFAULT SYSUTCDATETIME(),
  CONSTRAINT PK_GreetingRotationUsed PRIMARY KEY(AgentId,GreetingId),
  CONSTRAINT FK_GreetingRotationUsed_Agent FOREIGN KEY(AgentId) REFERENCES vac.Agents(AgentId) ON DELETE CASCADE,
  CONSTRAINT FK_GreetingRotationUsed_Greeting FOREIGN KEY(GreetingId) REFERENCES vac.GreetingLibrary(GreetingId)
);
GO
IF OBJECT_ID(N'vac.GreetingRotationState', N'U') IS NULL
CREATE TABLE vac.GreetingRotationState (
  AgentId nvarchar(128) NOT NULL CONSTRAINT PK_GreetingRotationState PRIMARY KEY,
  LastGreetingId nvarchar(128) NOT NULL,
  UpdatedAt datetimeoffset(3) NOT NULL CONSTRAINT DF_GreetingRotationState_UpdatedAt DEFAULT SYSUTCDATETIME(),
  CONSTRAINT FK_GreetingRotationState_Agent FOREIGN KEY(AgentId) REFERENCES vac.Agents(AgentId) ON DELETE CASCADE,
  CONSTRAINT FK_GreetingRotationState_Greeting FOREIGN KEY(LastGreetingId) REFERENCES vac.GreetingLibrary(GreetingId)
);
GO

/* Call history intentionally keeps the existing JSON payloads intact in phase 1. */
IF OBJECT_ID(N'vac.SimulatorCalls', N'U') IS NULL
CREATE TABLE vac.SimulatorCalls (
  CallId nvarchar(128) NOT NULL CONSTRAINT PK_SimulatorCalls PRIMARY KEY,
  AgentId nvarchar(128) NOT NULL,
  AgentName nvarchar(200) NOT NULL,
  CampaignId nvarchar(128) NULL,
  GreetingId nvarchar(128) NULL,
  UpstreamMode nvarchar(32) NOT NULL,
  SampleRateIn int NOT NULL,
  SampleRateOut int NOT NULL,
  StartedAt datetimeoffset(3) NOT NULL,
  EndedAt datetimeoffset(3) NOT NULL,
  DurationMs bigint NOT NULL,
  Turns int NOT NULL,
  AverageTtfbMs int NULL,
  Disposition nvarchar(64) NULL,
  TransferredTo nvarchar(256) NULL,
  RecordingRequested bit NOT NULL CONSTRAINT DF_SimulatorCalls_RecordingRequested DEFAULT 0,
  RecordingStatus nvarchar(24) NOT NULL CONSTRAINT DF_SimulatorCalls_RecordingStatus DEFAULT N'not_requested',
  RecordingFile nvarchar(512) NULL,
  RecordingMime nvarchar(100) NULL,
  RecordingBytes bigint NOT NULL CONSTRAINT DF_SimulatorCalls_RecordingBytes DEFAULT 0,
  RecordingTruncated bit NOT NULL CONSTRAINT DF_SimulatorCalls_RecordingTruncated DEFAULT 0,
  TranscriptJson nvarchar(max) NOT NULL,
  FunctionsJson nvarchar(max) NOT NULL,
  CONSTRAINT CK_SimulatorCalls_Transcript CHECK (ISJSON(TranscriptJson)=1),
  CONSTRAINT CK_SimulatorCalls_Functions CHECK (ISJSON(FunctionsJson)=1),
  CONSTRAINT CK_SimulatorCalls_Duration CHECK (DurationMs>=0)
);
GO
CREATE INDEX IX_SimulatorCalls_StartedAt ON vac.SimulatorCalls(StartedAt DESC);
CREATE INDEX IX_SimulatorCalls_AgentStarted ON vac.SimulatorCalls(AgentId,StartedAt DESC);
GO

IF OBJECT_ID(N'vac.BridgeCalls', N'U') IS NULL
CREATE TABLE vac.BridgeCalls (
  CallId nvarchar(128) NOT NULL CONSTRAINT PK_BridgeCalls PRIMARY KEY,
  Transport nvarchar(24) NOT NULL,
  Extension nvarchar(64) NOT NULL,
  CallerCode nvarchar(128) NOT NULL,
  LeadId nvarchar(128) NULL,
  Phone nvarchar(64) NOT NULL,
  CampaignId nvarchar(128) NULL,
  ViciCampaign nvarchar(128) NULL,
  AgentId nvarchar(128) NOT NULL,
  AgentName nvarchar(200) NOT NULL,
  GreetingId nvarchar(128) NULL,
  RemoteAgentUser nvarchar(128) NOT NULL,
  StartedAt datetimeoffset(3) NOT NULL,
  EndedAt datetimeoffset(3) NOT NULL,
  DurationMs bigint NOT NULL,
  Turns int NOT NULL,
  AverageTtfbMs int NULL,
  Disposition nvarchar(64) NULL,
  TransferredTo nvarchar(256) NULL,
  DncAdded bit NOT NULL CONSTRAINT DF_BridgeCalls_DncAdded DEFAULT 0,
  RecordingFile nvarchar(512) NULL,
  RecordingBytes bigint NOT NULL CONSTRAINT DF_BridgeCalls_RecordingBytes DEFAULT 0,
  TranscriptJson nvarchar(max) NOT NULL,
  FunctionsJson nvarchar(max) NOT NULL,
  ViciApiAuditJson nvarchar(max) NOT NULL,
  CONSTRAINT CK_BridgeCalls_Transcript CHECK (ISJSON(TranscriptJson)=1),
  CONSTRAINT CK_BridgeCalls_Functions CHECK (ISJSON(FunctionsJson)=1),
  CONSTRAINT CK_BridgeCalls_Audit CHECK (ISJSON(ViciApiAuditJson)=1),
  CONSTRAINT CK_BridgeCalls_Transport CHECK (Transport IN (N'audiosocket',N'sip_rtp')),
  CONSTRAINT CK_BridgeCalls_Duration CHECK (DurationMs>=0)
);
GO
CREATE INDEX IX_BridgeCalls_StartedAt ON vac.BridgeCalls(StartedAt DESC);
CREATE INDEX IX_BridgeCalls_AgentStarted ON vac.BridgeCalls(AgentId,StartedAt DESC);
CREATE INDEX IX_BridgeCalls_CampaignStarted ON vac.BridgeCalls(ViciCampaign,StartedAt DESC);
GO

/* Procedures provide explicit transactional save and bounded history pruning. */
CREATE OR ALTER PROCEDURE vac.SaveConsoleState
  @StateJson nvarchar(max),
  @UpdatedAt datetimeoffset(3),
  @Summary nvarchar(2000)=NULL
AS
BEGIN
  SET NOCOUNT ON;
  SET XACT_ABORT ON;
  IF ISJSON(@StateJson)<>1 THROW 51001,'State payload must be valid JSON.',1;
  BEGIN TRAN;
  UPDATE vac.ConsoleStore WITH (UPDLOCK,HOLDLOCK)
    SET [Value]=@StateJson, UpdatedAt=@UpdatedAt WHERE [Key]=N'active_state';
  IF @@ROWCOUNT=0
    INSERT vac.ConsoleStore([Key],[Value],UpdatedAt) VALUES(N'active_state',@StateJson,@UpdatedAt);
  INSERT vac.StateRevisions(SavedAt,Summary,Snapshot)
    VALUES(@UpdatedAt,COALESCE(NULLIF(@Summary,N''),N'Saved console state'),@StateJson);
  ;WITH keepers AS (
    SELECT RevisionId, ROW_NUMBER() OVER(ORDER BY RevisionId DESC) AS rn FROM vac.StateRevisions
  )
  DELETE FROM keepers WHERE rn>50;
  COMMIT;
END;
GO

CREATE OR ALTER PROCEDURE vac.PurgeExpiredSessions
AS
BEGIN
  SET NOCOUNT ON;
  DELETE FROM vac.UserSessions WHERE ExpiresAt<=SYSUTCDATETIME();
  DELETE FROM vac.RevokedAdminSessions WHERE ExpiresAt<=SYSUTCDATETIME();
END;
GO

CREATE OR ALTER PROCEDURE vac.RevokeUserSessions
  @UserId nvarchar(128)
AS
BEGIN
  SET NOCOUNT ON;
  DELETE FROM vac.UserSessions WHERE UserId=@UserId;
  SELECT @@ROWCOUNT AS RevokedCount;
END;
GO

/* Safe read helpers for dashboards; phone and transcripts should be access-controlled. */
CREATE OR ALTER VIEW vac.vw_CallHistorySummary
AS
  SELECT N'bridge' AS CallType, CallId, AgentId, AgentName, CampaignId,
         StartedAt, EndedAt, DurationMs, Turns, Disposition, TransferredTo,
         DncAdded, RecordingFile, RecordingBytes
  FROM vac.BridgeCalls
  UNION ALL
  SELECT N'simulator', CallId, AgentId, AgentName, CampaignId,
         StartedAt, EndedAt, DurationMs, Turns, Disposition, TransferredTo,
         CAST(0 AS bit), RecordingFile, RecordingBytes
  FROM vac.SimulatorCalls;
GO

INSERT vac.SchemaMigrations(MigrationId,Checksum,Description)
SELECT N'001_sqlserver_foundation',NULL,N'Initial SQL Server schema derived from current SQLite persistence'
WHERE NOT EXISTS (SELECT 1 FROM vac.SchemaMigrations WHERE MigrationId=N'001_sqlserver_foundation');
GO
