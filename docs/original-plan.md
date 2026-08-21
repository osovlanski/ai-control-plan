# Agnostic AI Agent Control Plane — Architecture & Implementation Plan (ORIGINAL PROPOSAL)

> **Status:** Superseded by `docs/architecture-review.md` and `docs/revised-architecture.md`.
> This is the original proposed reference architecture, kept verbatim for traceability.
> See the review for what was kept, changed, removed, and deferred — and why.

---

**Purpose:** Use this document as the starting point for design review, improvement, and implementation planning.
**Primary goal:** Build an agnostic control plane that accepts a task/prompt, catalogs available AI assistant environments, selects the best assistant for the task, observes execution, supports handoff and parallelism, and adapts routing as assistant capabilities and limits change.

## 1. Product Definition

Build an **AI Agent Control Plane**, not another AI assistant.

The system should:

1. Accept a user task/prompt.
2. Know which workspace is active: `personal` or `work`.
3. Catalog all AI assistant environments available in that workspace.
4. Understand each assistant's models/LLMs, tools, MCP servers, skills, plugins, repository access, execution abilities, health, and quota state.
5. Rank assistants according to the task and user-selected optimization criteria.
6. Run the selected assistant.
7. Normalize its execution into a provider-independent lifecycle.
8. Allow manual handoff, automatic failover, parallel execution, specialist pipelines.
9. Maintain a portable task state so another assistant can continue without losing essential context.
10. Continuously refresh routing knowledge from runtime discovery, provider metadata, and local benchmarks.

## 2. Initial Workspaces

- **Personal:** OpenAI Codex, Anthropic Claude / Claude Code. Policies: automatic quota failover, cross-provider handoff, parallel execution, auto-selection, local repo access, user-controlled routing criteria.
- **Work:** Claude / Claude Code, Cursor, OpenAI Codex, AWS Bedrock, future custom AWS/Bedrock agents. Policies: strict credential isolation, company-specific tools/MCP/skills, repository-specific capabilities, configurable failover, local + remote/EC2 runners.

## 3. Core Architecture (as originally proposed)

Web UI → Agent Control Plane (Task Router, Orchestrator, Capability Registry, Evaluation Engine, Limit Monitor, Event Normalizer) → Personal Runner / Work Runner / Remote Runner → provider assistants.

Principle: do not normalize every provider exclusively through MCP; create a common **Agent Adapter** abstraction using each assistant's richest supported integration.

## 4. Core Domain Abstractions

`TaskEnvelope`, `AgentAdapter`, `CapabilityRegistry`, `Router`, `NormalizedEventStream`.

## 5. Agent Adapter (original 17-method contract)

```ts
interface AgentAdapter {
  discoverCapabilities(): Promise<AssistantCapabilities>;
  getModels(): Promise<ModelInfo[]>;
  getTools(): Promise<ToolInfo[]>;
  getSkills(): Promise<SkillInfo[]>;
  getPlugins(): Promise<PluginInfo[]>;
  getMcpServers(): Promise<McpInfo[]>;
  startTask(task: TaskEnvelope): Promise<AgentSession>;
  resumeTask(sessionId: string, task: TaskEnvelope): Promise<AgentSession>;
  sendMessage(sessionId: string, message: string): Promise<void>;
  cancelTask(sessionId: string): Promise<void>;
  streamEvents(sessionId: string): AsyncIterable<ProviderEvent>;
  getUsage(sessionId: string): Promise<UsageInfo>;
  getLimits(): Promise<LimitInfo>;
  health(): Promise<HealthInfo>;
  createCheckpoint(sessionId: string): Promise<Checkpoint>;
  exportHandoff(sessionId: string): Promise<HandoffPackage>;
}
```

Adapters: Codex, Claude, Cursor, Bedrock, GenericMcp (future), GenericCli (fallback).

## 6–9. Workspace Isolation, Runner Architecture, Capability Registry, Capability Sync

- Workspace as first-class security/routing boundary; credentials on runners, not the central plane.
- Control Plane + Runner model (local Mac/Linux, workstation, EC2, dev VM).
- Capability records with per-capability evidence `{value, source, observedAt, confidence}`.
- Daily + on-demand capability sync; runtime evidence outranks documentation.

## 10–14. Task Intake, Classification, Routing Profiles, Routing Algorithm, Explainability

- Intake: prompt, workspace, repo, constraints, routing profile, parallel-allowed, explicit overrides.
- Classification: task type, complexity, requirements (heuristic + LLM assisted).
- Profiles: Auto / Best Quality / Fastest / Lowest Tokens / Lowest Cost / Best Tool Fit / Most Reliable / Long Context / Custom.
- Weighted multi-factor score (quality, speed, token, cost, tool fit, reliability, context fit) minus penalties.
- Explainable ranked recommendation before execution; persist routing reasons.

## 15–17. TaskEnvelope, Task Files, progress.md

- Provider-independent task state (goal, constraints, repo, status, completed, remaining, decisions, artifacts, next action).
- `.agent-control/tasks/<id>/` with task.md, progress.md, handoff.md, decisions.md, artifacts/.
- Database/event log = source of truth; Markdown = generated projection.

## 18–20. Lifecycle, Observability, Event Model

- ~21 normalized lifecycle states (CREATED…CANCELLED).
- Normalized activity timeline instead of raw chain-of-thought.
- Common `AgentEvent` structure, append-only storage.

## 21–24. Handoff, Limit Failover, Parallel Execution, Worktree Safety

- Checkpoint → TaskEnvelope + progress + decisions + diff + tests + logs → rank destinations → resume next agent.
- Personal workspace: automatic failover on quota_exceeded / rate_limited / provider_unavailable / runner_disconnected; cooldown penalties.
- Parallel modes: Race, Compare, Specialist Pipeline, Independent Reviewer.
- Never two assistants in one working tree; per-assistant git worktrees.

## 25–26. Local Evaluation Suite, Historical Scores

- Representative task corpus across categories; rolling metrics (success, quality, tests, time, tokens, cost, corrections).
- Scores segmented by workspace/repo/task-type/model/runtime version.

## 27–31. Backend Modules, Stack, Data Model, APIs, Frontend Screens

- ~13 services + 6 adapters + storage modules.
- TypeScript/Node, Fastify or NestJS, PostgreSQL (SQLite for MVP), Redis+BullMQ only when justified, SSE/WebSocket.
- Entities: Workspace, Runner, AssistantInstance, Capability, Model/Tool/Skill/Plugin/McpServer, Task, RoutingDecision, AgentSession, AgentEvent, Checkpoint, Handoff, UsageRecord, LimitState, Benchmark, Evaluation, AssistantScore.
- REST APIs for workspaces/assistants/tasks/handoff/parallel/events/benchmarks.
- FE screens: workspace switcher, new task, router recommendation, task dashboard, task details, assistant catalog, capability changes feed.

## 32–33. Security, Failure Model

- Credential isolation, runner-held secrets, workspace identity on every action, no cross-workspace handoff, audit, redaction, authenticated runner links.
- Explicit failure design: crashes, disconnects, limits, auth failure, tool/MCP failure, dirty repo, stuck agent, timeout, malformed events, incompatible handoff. Orchestration survives restart.

## 34–35. MVP Roadmap, Non-Goals

- Phase 1 core plane (Claude+Codex, routing, events, dashboard, TaskEnvelope, progress.md) → Phase 2 handoff & limits → Phase 3 work workspace (Cursor, Bedrock, remote runners) → Phase 4 intelligent routing (daily discovery, benchmarks, profiles) → Phase 5 multi-agent orchestration.
- Avoid: workflow DSL, self-modifying router, Kubernetes, dozens of providers, perfect pricing, raw CoT viewer, autonomous swarms, enterprise RBAC, billing, vector DB.

## 36–37. Differentiator, One-Liner

Route between **complete assistant environments** (runtime + model + skills + tools + MCP + account limits), not bare LLM APIs.

> An agnostic AI-agent control plane that catalogs available assistant environments, dynamically selects the best assistant for each task, observes execution through a normalized lifecycle, enables parallel collaboration and portable task handoff, and automatically reroutes work when capabilities, performance, or usage limits change.
