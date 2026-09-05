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
- Kernel services (2026-09-05, `docs/agentic-os-kernel-services.md`): the task machine gains exactly one state, `WAITING_RESOURCE`, for scheduler-resolved waits; outcomes never become states (CR-16). A scheduled task stores intent only and is re-composed at wake (I-S1).
- Model-level selection is kernel scope (M12); the earlier "deferred indefinitely" entry is withdrawn. Published benchmark scores are cold-start priors weighted `1 − n/(n+k)`; own telemetry dominates as runs accumulate and can never be switched off (CR-17, I-M2). Running synthetic benchmarks stays rejected.
- Context management is a Harness guard with a fixed ladder (warn → prune → compact → verify → checkpoint + clean session); it never clears a session and never mutates persisted history (I-C1, I-C3). Provider `/compact` is a mechanism, not the architecture.
- No `RuntimeBackend` interface before its second implementation; herdr and DeepSeek Harness are optional backends/adapters on demonstrated need, never dependencies (CR-28).
- The Control Plane owns pricing (model catalog, `pricingVersion`) and schedules; Cockpit renders both and creates schedules only through `commands.write` (CR-19, CR-20).
