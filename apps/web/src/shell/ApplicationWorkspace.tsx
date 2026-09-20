import type { Workspace } from "../api.js";
import type { Application } from "./routes.js";

const WORKSPACES = {
  memory: {
    title: "Memory", intro: "Context with a source. Knowledge you can inspect.",
    available: "Mission context observations and checkpoints are available in Overview. Cockpit provides durable memory graphs, Garden findings, context sources and knowledge search.",
    planned: "Recall and a searchable memory list in this shell need the authenticated memory registry. Repository scope, source provenance, retention and redaction will travel with every entry. No memory entries have been loaded here.",
    action: "Inspect mission context",
  },
  routing: {
    title: "Routing", intro: "Automatic by default. Explainable at every decision.",
    available: "Preview a goal in Overview to see the selected environment and the rule that chose it. Mission evidence retains eligibility filters, quota observations and model recommendations. Advanced intake controls allow explicit overrides.",
    planned: "A workspace-wide policy editor is planned. Model catalog facts, observed task outcomes and external benchmark priors remain separate evidence; advisory recommendations do not imply execution.",
    action: "Preview a mission route",
  },
  traces: {
    title: "Traces", intro: "Follow the work, from intent to outcome.",
    available: "Select a mission in Overview for its recent activity, then open full controls for normalized events, handoffs, checkpoints, sessions, verification and reported usage. Cockpit retains logs and Usage/Retro for externally observed sessions.",
    planned: "A cross-mission timeline and unified external-session usage require correlation and ingestion contracts. Unknown cost and token usage will remain unknown.",
    action: "Explore mission activity",
  },
  tools: {
    title: "Tools", intro: "The capabilities your agents can use.",
    available: "Cockpit manages installed skills (instructions), plugins (bundles), hooks (lifecycle automation), tools (callable actions) and MCP servers (tool connections). Agents here exposes discovered capability manifests.",
    planned: "The authenticated capability registry will bring inventory, installation state, permissions, provenance and workspace compatibility into this application. Per-mission attachment and provisioning are not yet available.",
    action: "Inspect agent capabilities", href: "#/agents",
  },
  settings: {
    title: "Settings", intro: "Your workspace. Your execution boundaries.",
    available: "The current workspace comes from the control plane. Mission waits and schedule controls remain in the inspector. Cockpit owns machine-global provider configuration and its local/cloud/plane Schedule view.",
    planned: "In-shell editing of providers, authentication, policies, routing defaults, recurring schedules, retention, redaction and appearance is planned. Existing configuration and security boundaries remain authoritative.",
    action: "Open mission controls",
  },
} as const;

export function ApplicationWorkspace({ screen, workspace }: { screen: Application | "unavailable"; workspace: Workspace | null }) {
  if (!(screen in WORKSPACES)) return <section className="application-workspace">
    <h1>Page unavailable</h1><p>This destination does not exist.</p><a href="#/overview">Open Overview</a>
  </section>;
  const content = WORKSPACES[screen as keyof typeof WORKSPACES];
  return <section className="application-workspace" aria-label={content.title}>
    <div className="application-heading"><span className="eyebrow">Workspace</span><h1>{content.title}</h1><p>{content.intro}</p></div>
    <div className="application-status"><h2>Available today</h2><p>{content.available}</p>
      {screen === "settings" && <p>Current workspace: <strong>{workspace?.workspace ?? "Unavailable"}</strong></p>}
      <a className="btn" href={"href" in content ? content.href : "#/overview"}>{content.action} <span aria-hidden="true">↗</span></a>
    </div>
    <div className="application-planned"><h2>Planned integration</h2><p>{content.planned}</p></div>
  </section>;
}
