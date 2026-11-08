# Phase 0 — Architecture Baseline & Product Definition

**Product:** MMA Digital Labs — Universal AI Voice Agent Console  
**Repository:** https://github.com/muneeb819/Voice-Agent-Console  
**Branch:** `phase-0/architecture-baseline`  
**Baseline inspected:** `main` at `c2429114f6dccd5699817a067efef0f235e3d070`

## 1. Phase 0 outcome

This phase establishes the product boundary, records the observed repository baseline, defines the target architecture and creates the implementation guardrails for Phase 1. It does not claim production readiness or certify live carrier/customer calls.

## 2. Product definition

Build a provider-neutral, telephony-neutral, industry-neutral platform to create, configure, test, deploy, operate and improve multiple AI voice agents.

Core capabilities:
- Agent and campaign lifecycle management.
- Reusable agent templates, personas, prompts, tools and knowledge sources.
- Pluggable LLM, speech-to-text, text-to-speech and realtime voice providers.
- Browser simulator, sandbox calls, evaluation suites and release gates.
- Telephony adapters, queues, transfers and human handoff.
- Recording, operational events, errors, session duration, monitoring and audit controls.
- Deployment, versioning, rollback and environment management.

“Unlimited agents” means no arbitrary product-level agent-count cap. Actual concurrency and throughput remain bounded by infrastructure, provider quotas, network, storage and budget.

## 3. Observed repository baseline

The repository currently contains a Node.js/TypeScript application with Express and WebSocket functionality, SQLite-backed persistence, a separate Python speech-service component, Docker assets, Deepgram integrations, browser voice testing and VICIdial/Asterisk bridge work.

Existing product areas include Agent, Campaign, Voice, Testing, Wallboard and Configuration. The repository also contains a greeting library and bridge-related code.

The current architecture should be treated as a modular monolith plus a separate speech service until deployment/runtime evidence proves otherwise. Do not describe it as a fully distributed or provider-neutral production platform yet.

## 4. Baseline risks and gaps to resolve

1. Provider integrations and secrets need a formal adapter/configuration contract; current environment examples include vendor-specific credentials.
2. Telephony bridge code needs a documented support matrix and real end-to-end tests against the target VICIdial/Asterisk/carrier environment.
3. The speech-service Docker Compose configuration publishes port 8000 on all interfaces; production exposure must be restricted behind authenticated private networking or a secured gateway.
4. Admin authentication, role-based access, secret handling, tenant boundaries and audit logging need explicit security review.
5. Recording retention, consent, access controls, encryption and deletion policy need to be specified per deployment jurisdiction.
6. CI currently has a GitHub Pages/Jekyll workflow; a product build/test/security pipeline and deployment gates are still required.
7. Test reports in the repository are historical project evidence, not an independent certification. Live Deepgram/carrier/VICIdial/Asterisk behavior must be tested in a controlled environment.
8. Public documentation should distinguish the static documentation site from the running application.

## 5. Target logical architecture

- **Admin/API layer:** authentication, authorization, tenant/workspace management, agent/campaign CRUD, configuration and audit APIs.
- **Control plane:** versioned agent definitions, provider registry, policy validation, release approvals and deployment orchestration.
- **Runtime plane:** isolated call/session workers, realtime orchestration, tool execution, retries, timeouts and human handoff.
- **Provider adapters:** normalized contracts for LLM, STT, TTS, realtime voice, embeddings and optional evaluation providers.
- **Telephony adapters:** VICIdial/Asterisk first, with a stable interface for additional SIP/PBX/contact-center systems.
- **Data layer:** relational configuration store, secrets vault, object storage for recordings, event/metrics store and backup/restore.
- **Observability:** structured logs, metrics, traces, session outcomes, error events and operational dashboards.
- **Deployment layer:** local development, staging and production environments; containerized services; health checks, migrations, rollback and capacity controls.

Keep provider-specific code behind adapters. Keep campaign policy separate from agent persona and runtime infrastructure. Keep control-plane operations separate from latency-sensitive call processing.

## 6. Domain boundaries

Initial bounded domains:
- Identity, access and tenancy
- Agent definitions and versions
- Campaigns, policies and compliance rules
- Provider connections and credentials
- Voice assets and voice configuration
- Test cases, evaluations and release gates
- Runtime sessions and call orchestration
- Telephony and human transfer
- Recordings and retention
- Monitoring, analytics and audit
- Deployment and environment management

## 7. Phase 1 implementation backlog

**P0 — required before feature expansion**
- Map the actual application entrypoints, route tree, persistence schema and runtime startup sequence.
- Add architecture decision records (ADRs) and a system context/container diagram.
- Define typed interfaces for provider adapters and telephony adapters.
- Define environment configuration validation and fail-closed secret handling.
- Establish CI for install, typecheck, lint, unit tests, build and dependency/security checks.
- Restrict speech-service network exposure and document secure deployment defaults.
- Add health/readiness checks and a repeatable local/staging startup procedure.

**P1 — foundation**
- Define tenant/workspace and role permission model.
- Define versioned agent/campaign schemas and migration strategy.
- Define session event and recording metadata contracts.
- Define provider capability discovery, timeout, retry and fallback behavior.
- Define release lifecycle: draft → validate → test → approve → deploy → monitor → rollback.

## 8. Phase 0 exit criteria

- [x] Repository baseline inspected and current product scope documented.
- [x] Product boundaries and non-goals stated.
- [x] Target logical architecture and domain boundaries defined.
- [x] Risks and Phase 1 priorities recorded.
- [x] Work isolated on a dedicated branch.
- [ ] Architecture diagram and ADR set committed in Phase 1.
- [ ] CI and security gates implemented and run.
- [ ] Clean-checkout build and tests independently executed.
- [ ] Live telephony/provider integration validated in a controlled environment before production claims.

## 9. Non-goals for Phase 0

No rewrite, no production deployment, no live outbound calling, no credential rotation, no carrier/VICIdial configuration changes, and no claim of regulatory certification are included in this phase.

## 10. Acceptance note

Phase 0 is a planning and baseline milestone. Repository inspection and this baseline document are complete. Phase 0 is not fully closed until the remaining verification items above are completed; Phase 1 work should begin with the P0 backlog.
