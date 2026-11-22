/*
  MMA Digital Labs — Voice Agent Console
  002: per-bot call-start, greeting, speaking-style and voice settings.
  Mirrors the fields the console saves with each bot (src/types.ts: AgentFlow,
  AgentBehavior.speakingStyle, Agent.tts.expressiveness / variation) and the
  SQLite greeting_line_used shuffle bag (src/db.ts).
  Run after 001_schema.sql against VAC_Console. Idempotent; never drops data.
*/
SET NOCOUNT ON;
SET XACT_ABORT ON;
GO

IF DB_NAME() <> N'VAC_Console'
  THROW 51000, 'Select the VAC_Console database before running this script.', 1;
GO

/* One row per bot: everything an operator sets on the bot page for how a call sounds and starts. */
IF OBJECT_ID(N'vac.BotCallSettings', N'U') IS NULL
CREATE TABLE vac.BotCallSettings (
  AgentId           nvarchar(128) NOT NULL CONSTRAINT PK_BotCallSettings PRIMARY KEY,
  -- Call start
  WaitForHello      bit           NOT NULL CONSTRAINT DF_BotCallSettings_WaitForHello DEFAULT 1,
  WaitForHelloSec   decimal(4,1)  NOT NULL CONSTRAINT DF_BotCallSettings_WaitSec DEFAULT 3.0,
  NoAnswerLine      nvarchar(200) NOT NULL CONSTRAINT DF_BotCallSettings_NoAnswer DEFAULT N'Hello? Are you there?',
  NoAnswerRepeats   tinyint       NOT NULL CONSTRAINT DF_BotCallSettings_Repeats DEFAULT 2,
  -- Greeting and flow
  GreetingMaxWords  tinyint       NOT NULL CONSTRAINT DF_BotCallSettings_MaxWords DEFAULT 20,
  IntroLine         nvarchar(600) NOT NULL CONSTRAINT DF_BotCallSettings_Intro DEFAULT N'',
  TransferOnYes     bit           NOT NULL CONSTRAINT DF_BotCallSettings_TransferOnYes DEFAULT 0,
  RepeatLine        nvarchar(300) NOT NULL CONSTRAINT DF_BotCallSettings_Repeat DEFAULT N'Sorry, I didn''t quite catch that. Could you say that again for me?',
  -- Personality and voice
  SpeakingStyle     nvarchar(max) NOT NULL CONSTRAINT DF_BotCallSettings_Style DEFAULT N'',
  VoiceSpeed        decimal(4,2)  NOT NULL CONSTRAINT DF_BotCallSettings_Speed DEFAULT 1.00,
  FluxExpressivity  smallint      NOT NULL CONSTRAINT DF_BotCallSettings_Expr DEFAULT 0,
  Expressiveness    decimal(4,2)  NOT NULL CONSTRAINT DF_BotCallSettings_Exaggeration DEFAULT 0.50,
  Variation         decimal(4,2)  NOT NULL CONSTRAINT DF_BotCallSettings_Temperature DEFAULT 0.80,
  UpdatedAt         datetimeoffset(3) NOT NULL CONSTRAINT DF_BotCallSettings_UpdatedAt DEFAULT SYSUTCDATETIME(),
  CONSTRAINT FK_BotCallSettings_Agent FOREIGN KEY (AgentId) REFERENCES vac.Agents(AgentId) ON DELETE CASCADE,
  CONSTRAINT CK_BotCallSettings_WaitSec CHECK (WaitForHelloSec BETWEEN 1.0 AND 10.0),
  CONSTRAINT CK_BotCallSettings_Repeats CHECK (NoAnswerRepeats BETWEEN 0 AND 5),
  CONSTRAINT CK_BotCallSettings_MaxWords CHECK (GreetingMaxWords BETWEEN 5 AND 40),
  CONSTRAINT CK_BotCallSettings_Speed CHECK (VoiceSpeed BETWEEN 0.25 AND 4.00),
  CONSTRAINT CK_BotCallSettings_Expr CHECK (FluxExpressivity BETWEEN -2 AND 2),
  CONSTRAINT CK_BotCallSettings_Exaggeration CHECK (Expressiveness BETWEEN 0.25 AND 2.00),
  CONSTRAINT CK_BotCallSettings_Temperature CHECK (Variation BETWEEN 0.30 AND 1.50)
);
GO

/* The bot's own greeting lines, one row per line, in the operator's order. */
IF OBJECT_ID(N'vac.BotGreetingLines', N'U') IS NULL
CREATE TABLE vac.BotGreetingLines (
  AgentId   nvarchar(128) NOT NULL,
  LineNumber    int           NOT NULL,
  LineText  nvarchar(400) NOT NULL,
  LineKey   AS CONVERT(char(64), HASHBYTES('SHA2_256', LineText), 2) PERSISTED,
  CONSTRAINT PK_BotGreetingLines PRIMARY KEY (AgentId, LineNumber),
  CONSTRAINT FK_BotGreetingLines_Agent FOREIGN KEY (AgentId) REFERENCES vac.Agents(AgentId) ON DELETE CASCADE,
  CONSTRAINT CK_BotGreetingLines_Text CHECK (LEN(LTRIM(RTRIM(LineText))) > 0)
);
GO

/* Shuffle bag: lines already spoken in the current cycle (every line once before any repeats). */
IF OBJECT_ID(N'vac.BotGreetingLineUsed', N'U') IS NULL
CREATE TABLE vac.BotGreetingLineUsed (
  AgentId nvarchar(128) NOT NULL,
  LineKey char(64)      NOT NULL,
  UsedAt  datetimeoffset(3) NOT NULL CONSTRAINT DF_BotGreetingLineUsed_UsedAt DEFAULT SYSUTCDATETIME(),
  CONSTRAINT PK_BotGreetingLineUsed PRIMARY KEY (AgentId, LineKey),
  CONSTRAINT FK_BotGreetingLineUsed_Agent FOREIGN KEY (AgentId) REFERENCES vac.Agents(AgentId) ON DELETE CASCADE
);
GO
CREATE INDEX IX_BotGreetingLineUsed_Recent ON vac.BotGreetingLineUsed(AgentId, UsedAt DESC);
GO

/* Save one bot's call settings and greeting lines in one transaction (front-end Save). */
CREATE OR ALTER PROCEDURE vac.usp_BotCallSettings_Save
  @AgentId nvarchar(128),
  @WaitForHello bit, @WaitForHelloSec decimal(4,1), @NoAnswerLine nvarchar(200), @NoAnswerRepeats tinyint,
  @GreetingMaxWords tinyint, @IntroLine nvarchar(600), @TransferOnYes bit, @RepeatLine nvarchar(300),
  @SpeakingStyle nvarchar(max), @VoiceSpeed decimal(4,2), @FluxExpressivity smallint,
  @Expressiveness decimal(4,2), @Variation decimal(4,2),
  @GreetingLines nvarchar(max) -- one greeting per line, as typed on the bot page
AS
BEGIN
  SET NOCOUNT ON;
  SET XACT_ABORT ON;
  IF NOT EXISTS (SELECT 1 FROM vac.Agents WHERE AgentId = @AgentId) THROW 51010, 'Unknown bot.', 1;
  BEGIN TRAN;
  MERGE vac.BotCallSettings WITH (HOLDLOCK) AS t
  USING (SELECT @AgentId AS AgentId) AS s ON t.AgentId = s.AgentId
  WHEN MATCHED THEN UPDATE SET
    WaitForHello = @WaitForHello, WaitForHelloSec = @WaitForHelloSec, NoAnswerLine = @NoAnswerLine,
    NoAnswerRepeats = @NoAnswerRepeats, GreetingMaxWords = @GreetingMaxWords, IntroLine = @IntroLine,
    TransferOnYes = @TransferOnYes, RepeatLine = @RepeatLine, SpeakingStyle = @SpeakingStyle,
    VoiceSpeed = @VoiceSpeed, FluxExpressivity = @FluxExpressivity, Expressiveness = @Expressiveness,
    Variation = @Variation, UpdatedAt = SYSUTCDATETIME()
  WHEN NOT MATCHED THEN INSERT (AgentId, WaitForHello, WaitForHelloSec, NoAnswerLine, NoAnswerRepeats,
    GreetingMaxWords, IntroLine, TransferOnYes, RepeatLine, SpeakingStyle, VoiceSpeed, FluxExpressivity,
    Expressiveness, Variation)
  VALUES (@AgentId, @WaitForHello, @WaitForHelloSec, @NoAnswerLine, @NoAnswerRepeats, @GreetingMaxWords,
    @IntroLine, @TransferOnYes, @RepeatLine, @SpeakingStyle, @VoiceSpeed, @FluxExpressivity,
    @Expressiveness, @Variation);

  DELETE FROM vac.BotGreetingLines WHERE AgentId = @AgentId;
  -- Split on line breaks, keeping the operator's order (SQL Server 2016+: the
  -- text is escaped into a JSON array and read back with its index).
  DECLARE @Json nvarchar(max) = N'["' + REPLACE(REPLACE(STRING_ESCAPE(COALESCE(@GreetingLines, N''), 'json'), N'\r', N''), N'\n', N'","') + N'"]';
  INSERT vac.BotGreetingLines (AgentId, LineNumber, LineText)
  SELECT @AgentId, ROW_NUMBER() OVER (ORDER BY CAST(o.[key] AS int)), LTRIM(RTRIM(o.[value]))
  FROM OPENJSON(@Json) AS o
  WHERE LEN(LTRIM(RTRIM(o.[value]))) > 0;
  -- Lines that no longer exist leave the shuffle bag.
  DELETE u FROM vac.BotGreetingLineUsed u
  WHERE u.AgentId = @AgentId AND NOT EXISTS (SELECT 1 FROM vac.BotGreetingLines l WHERE l.AgentId = u.AgentId AND l.LineKey = u.LineKey);
  COMMIT;
END;
GO

/* Everything the call needs about one bot (read at the start of every call). */
CREATE OR ALTER PROCEDURE vac.usp_BotCallSettings_Get
  @AgentId nvarchar(128)
AS
BEGIN
  SET NOCOUNT ON;
  SELECT * FROM vac.BotCallSettings WHERE AgentId = @AgentId;
  SELECT LineNumber, LineText FROM vac.BotGreetingLines WHERE AgentId = @AgentId ORDER BY LineNumber;
END;
GO

/*
  Pick this call's greeting: random among lines not yet used this cycle and no
  longer than GreetingMaxWords; when all are used, start a new cycle without
  repeating the last line. Returns no row when the bot has no usable line.
*/
CREATE OR ALTER PROCEDURE vac.usp_BotGreeting_Pick
  @AgentId nvarchar(128)
AS
BEGIN
  SET NOCOUNT ON;
  SET XACT_ABORT ON;
  DECLARE @MaxWords int = COALESCE((SELECT GreetingMaxWords FROM vac.BotCallSettings WHERE AgentId = @AgentId), 20);
  DECLARE @Pick TABLE (LineKey char(64), LineText nvarchar(400));
  BEGIN TRAN;
  -- Serialize picks per bot so two calls starting together never take the same line.
  EXEC sp_getapplock @Resource = @AgentId, @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 5000;

  ;WITH usable AS (
    SELECT LineKey, LineText FROM vac.BotGreetingLines
    WHERE AgentId = @AgentId
      AND (LEN(LTRIM(RTRIM(LineText))) - LEN(REPLACE(LTRIM(RTRIM(LineText)), N' ', N'')) + 1) <= @MaxWords
  )
  INSERT @Pick SELECT TOP (1) u.LineKey, u.LineText FROM usable u
  WHERE NOT EXISTS (SELECT 1 FROM vac.BotGreetingLineUsed x WHERE x.AgentId = @AgentId AND x.LineKey = u.LineKey)
  ORDER BY NEWID();

  IF NOT EXISTS (SELECT 1 FROM @Pick)
  BEGIN
    DECLARE @Last char(64) = (SELECT TOP (1) LineKey FROM vac.BotGreetingLineUsed WHERE AgentId = @AgentId ORDER BY UsedAt DESC);
    DELETE FROM vac.BotGreetingLineUsed WHERE AgentId = @AgentId;
    ;WITH usable AS (
      SELECT LineKey, LineText FROM vac.BotGreetingLines
      WHERE AgentId = @AgentId
        AND (LEN(LTRIM(RTRIM(LineText))) - LEN(REPLACE(LTRIM(RTRIM(LineText)), N' ', N'')) + 1) <= @MaxWords
    )
    INSERT @Pick SELECT TOP (1) u.LineKey, u.LineText FROM usable u
    WHERE u.LineKey <> COALESCE(@Last, '') OR (SELECT COUNT(*) FROM usable) = 1
    ORDER BY NEWID();
  END;

  INSERT vac.BotGreetingLineUsed (AgentId, LineKey)
  SELECT @AgentId, LineKey FROM @Pick;
  COMMIT;
  SELECT LineText AS Greeting FROM @Pick;
END;
GO

INSERT vac.SchemaMigrations(MigrationId,Checksum,Description)
SELECT N'002_bot_call_settings',NULL,N'Per-bot call start, greeting lines, speaking style and voice settings with save/get/pick procedures'
WHERE NOT EXISTS (SELECT 1 FROM vac.SchemaMigrations WHERE MigrationId=N'002_bot_call_settings');
GO
