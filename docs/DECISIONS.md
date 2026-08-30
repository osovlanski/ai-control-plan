# Decisions

- Route complete assistant environments, not bare models. Supported by README and adapter contracts.
- Start with deterministic eligibility and explainable preference routing; telemetry informs later selection. Supported by architecture review and implementation.
- Isolate personal/work data using separate control-plane processes and workspace directories. Supported by configuration and isolation tests.
- Keep provider credentials outside the plane database/configuration. Supported by revised architecture and adapter authentication probes.
- Use normalized events and portable checkpoints as the handoff boundary. Supported by core contracts and orchestration implementation.
- Use SQLite for the local-first prototype. Supported by API dependencies and migrations.
- Remote runners and broader Agentic OS services remain proposals, not accepted implementation commitments.
- Maintain this as a documentation worktree of the control plane, proven by Git worktree metadata and common history.
- Treat the Agentic OS lifecycle/contracts as proposed until merged and implemented.
- Preserve the existing control-plane adapter/event/checkpoint boundaries as the base of any wider platform.
- No evidence supports an independent deployment or product identity for this worktree.
