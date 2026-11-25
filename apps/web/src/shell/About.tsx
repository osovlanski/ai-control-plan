import "../styles/about.css";

const COMPONENTS = [
  ["Shell / desktop", "Operator UI", "Describe a goal, preview its route, answer approvals and inspect the work in Overview or Missions."],
  ["Kernel / scheduler", "Control plane", "Owns task and run state, durable waits, resource admission, checkpoints and recovery. The router records why an assistant is eligible and why it was chosen."],
  ["Processes", "Tasks and runs", "A task holds the goal; a run is an execution attempt by an assistant. Repository work uses isolated worktrees. Compare and race can run alternative attempts."],
  ["Device drivers", "Provider adapters", "A shared execution interface connects Claude Code, Codex and other configured environments. Each adapter declares its capabilities; support differs by provider."],
  ["Package manager / configuration", "Cockpit and the Composer", "Cockpit owns installed assets and global configuration. When enabled, the Composer selects supported assets, requests a context bundle and binds a per-run profile."],
  ["Memory / filesystem", "Context and checkpoints", "Context bundles supply instructions and selected memory. Checkpoints preserve work for continuation. Cockpit owns durable memory; context observations report what a provider exposes."],
  ["System logs / accounting", "Events and usage evidence", "Normalized events, routing decisions, verification results and usage records explain what happened. Unknown model identity, tokens or cost remain explicit."],
] as const;

const LIFECYCLE = [
  { title: "Prompt", text: "Describe the goal, repository and constraints. Previewing records a task and its route without starting an agent." },
  { title: "Routing", text: "Filter configured assistants by capability, availability and policy, then explain the choice. When enabled, composition also prepares assets, context and a run policy." },
  { title: "Execution", text: "Start the selected adapter in the task workspace and stream events. Approvals can pause the run; configured waits and failover can continue from a checkpoint." },
  { title: "Verification", text: "Evaluate the configured checks and preserve their evidence. Checks can pass, fail, be blocked or be skipped. Required failures or blocked checks need operator attention." },
  { title: "Result", text: "Review the answer, changes, checkpoint and verification record. Provider completion alone does not prove correctness; skipped checks are not passing checks." },
] as const;

export function About() {
  return <article className="about-page" aria-labelledby="about-title">
    <header className="application-heading about-intro">
      <span className="eyebrow">About / Architecture</span>
      <h1 id="about-title">About Agentic OS</h1>
      <p>A local-first control plane for AI work.</p>
      <p>Agentic OS coordinates assistant environments around a goal: choose where work runs,
        follow its execution, preserve progress and inspect the result. You stay in command of
        the workspace, policy and approvals.</p>
    </header>

    <section className="about-section" aria-labelledby="about-linux">
      <span className="eyebrow">01 · Architecture</span>
      <h2 id="about-linux">An operating-system analogy</h2>
      <p>Like a traditional Linux system, Agentic OS separates the interface, scheduling,
        execution and shared services. This is an architectural analogy: Agentic OS is an
        application running on your host OS, not a Linux distribution or a replacement for its security boundaries.</p>
      <table className="about-comparison">
        <caption>Linux concepts and their Agentic OS counterparts</caption>
        <thead><tr><th scope="col">Linux system</th><th scope="col">Agentic OS</th></tr></thead>
        <tbody>{COMPONENTS.map(([linux, component, explanation]) => <tr key={linux}>
          <th scope="row">{linux}</th><td><strong>{component}</strong><p>{explanation}</p></td>
        </tr>)}</tbody>
      </table>
    </section>

    <section className="about-section" aria-labelledby="about-lifecycle">
      <span className="eyebrow">02 · Lifecycle</span>
      <h2 id="about-lifecycle">From prompt to result</h2>
      <p>The normal path is prompt → routing → execution → verification → result.
        A wait, approval or recovery can pause that path; the recorded state explains what happens next.</p>
      <ol className="about-lifecycle">
        {LIFECYCLE.map(({ title, text }, index) => <li key={title}>
          <span className="about-step" aria-hidden="true">0{index + 1}</span>
          <div><h3>{title}</h3><p>{text}</p></div>
        </li>)}
      </ol>
    </section>

    <section className="about-section" aria-labelledby="about-status">
      <span className="eyebrow">03 · Capability status</span>
      <h2 id="about-status">Implemented, gated and planned</h2>
      <p>This describes the implementation and shipped defaults, not the live configuration of your workspace.
        Routing records and agent capabilities show what a particular run can use.</p>
      <div className="about-capabilities">
        <section aria-labelledby="about-models">
          <span className="about-status about-status-gated">Shadow by default · activation gated</span>
          <h3 id="about-models">Automatic model selection</h3>
          <p>Automatic routing between assistant environments is implemented. Model recommendations are
            advisory by default: a shadow recommendation does not change execution. Applying one requires
            explicit enablement and all evidence and review gates to pass. Explicit model overrides and
            composed model requests are supported; the served model is recorded separately when the provider reports it.</p>
        </section>
        <section aria-labelledby="about-subtasks">
          <span className="about-status about-status-planned">Planned</span>
          <h3 id="about-subtasks">Automatic subtasks</h3>
          <p>Automatically decomposing a prompt into a coordinated tree of subtasks is planned.
            Existing task dependencies and parallel compare/race runs are implemented, but do not perform
            automatic task decomposition. Provider-internal subagents are separate from plane-managed subtasks.</p>
        </section>
        <section aria-labelledby="about-plugins">
          <span className="about-status about-status-planned">Partly implemented · broader support planned</span>
          <h3 id="about-plugins">Agent plugins</h3>
          <p>Opt-in composition can attach compatible skills and stdio MCP servers from Cockpit,
            with per-run provisioning and provider-specific fidelity. General plugin bundles, hooks,
            rules and composed subagents are not attachable yet. Installed inventory does not mean
            an asset was selected, provisioned or invoked by a run.</p>
        </section>
        <section aria-labelledby="about-codex">
          <span className="about-status about-status-implemented">Implemented · conditional</span>
          <h3 id="about-codex">Codex fallback</h3>
          <p>Codex is an implemented execution adapter and can be a failover destination. Automatic
            failover depends on configuration, enabled triggers and an eligible alternative assistant;
            Codex is not a guaranteed or hard-coded backup. The plane checkpoints and routes again.
            If no assistant qualifies, work waits for a resource or operator intervention.</p>
        </section>
      </div>
    </section>

    <footer className="about-footer">
      <p>Inspect the evidence behind your next run.</p>
      <nav aria-label="Explore Agentic OS">
        <a className="btn" href="#/overview">Open Overview</a>
        <a className="btn" href="#/agents">Inspect agents</a>
        <a className="btn" href="#/routing">Explore routing</a>
      </nav>
    </footer>
  </article>;
}
