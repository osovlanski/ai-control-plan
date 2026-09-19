import { useEffect, useRef, useState } from "react";
import { api, type SchedulerStatus, type Workspace } from "./api.js";
import { TaskDetail } from "./TaskDetail.jsx";
import { OrbitalBoard } from "./OrbitalBoard.js";
import { onAuthExpired } from "./auth.js";
import { StandaloneShell } from "./shell/StandaloneShell.js";
import { Catalog } from "./shell/Agents.js";
import { ApplicationWorkspace } from "./shell/ApplicationWorkspace.js";
import { APPLICATIONS, readRoute, useShellRoute } from "./shell/routes.js";

/** Scheduler ownership as the system health signal — read, never inferred. */
function SystemHealth() {
  const [status, setStatus] = useState<SchedulerStatus | null | "unavailable">(null);
  useEffect(() => {
    const load = () => api.schedulerStatus().then(setStatus).catch(() => setStatus("unavailable"));
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);
  const tone =
    status === null ? "neutral" : status === "unavailable" ? "limit" : status.armed ? "active" : status.enabled ? "neutral" : "human";
  return (
    <div className={`os-health tone-${tone}`} role="status">
      <i />
      {status === null ? (
        "Reading scheduler"
      ) : status === "unavailable" ? (
        "Scheduler status unavailable"
      ) : (
        <>
          <b>{status.armed ? "Scheduler armed" : status.enabled ? "Scheduler idle" : "Scheduler disabled"}</b>
          <span>
            {status.dueConditions} due · {status.openDispatches} open
          </span>
        </>
      )}
    </div>
  );
}

export function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [route] = useShellRoute();
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const main = useRef<HTMLElement>(null);
  const previousRoute = useRef(readRoute().key);
  const application = route.screen === "mission" ? "overview" : route.screen;
  const label = route.screen === "shell" ? "Shell" : APPLICATIONS.find(a => a.screen === application)?.label ?? "Page unavailable";

  useEffect(() => onAuthExpired(() => setExpired(true)), []);
  useEffect(() => {
    let disposed = false;
    api.workspace().then(w => { if (!disposed) setWorkspace(w); })
      .catch((e: Error) => { if (!disposed) setError(e.message); });
    return () => { disposed = true; };
  }, []);
  useEffect(() => {
    document.title = `${label} · Agentic OS`;
    if (previousRoute.current !== route.key) {
      main.current?.focus();
      window.scrollTo(0, 0);
      previousRoute.current = route.key;
    }
  }, [route.key, label]);

  if (expired) return <div className="os-expired">
    <h1>Session expired — re-open with <code>pnpm --filter @agent-plane/api open</code></h1>
  </div>;
  return <div className={`os-shell ${route.screen === "shell" ? "is-shell-mode" : ""}`}>
    <a className="skip-link" href="#main-content" onClick={e => { e.preventDefault(); main.current?.focus(); }}>Skip to workspace</a>
    <div className="os-environment" aria-hidden="true" />
    <aside className="os-rail" hidden={route.screen === "shell"}>
      <div className="os-identity"><div className="os-mark" aria-hidden="true" />
        <div><strong>Agentic <em>OS</em></strong><span>A workspace for AI work</span></div>
      </div>
      <nav aria-label="System">
        {APPLICATIONS.map(n => <a key={n.screen} className="os-nav" href={`#/${n.screen}`}
          aria-current={application === n.screen ? "page" : undefined}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d={n.icon} /></svg>
          <span>{n.label}</span>
        </a>)}
      </nav>
      <div className="os-rail-foot"><span>Local workspace<br />You stay in command.</span></div>
    </aside>
    <div className="os-main">
      <header className="os-topbar">
        <div className="os-brand"><strong>{label}</strong><span>Agentic OS</span></div>
        <a className="btn" href={route.screen === "shell" ? "#/overview" : "#/shell"}>{route.screen === "shell" ? "Operator mode" : "Shell mode"}</a>
        {workspace && <span className="os-workspace">{workspace.workspace}</span>}
        <SystemHealth />
      </header>
      <main id="main-content" tabIndex={-1} ref={main}>
        {error && <p className="error" role="alert">Workspace unavailable: {error}</p>}
        {/* Retain private in-memory drafts while navigating applications. */}
        <div hidden={route.screen !== "overview"}>
          <OrbitalBoard active={route.screen === "overview"} onOpen={taskId => { window.location.hash = `/missions/${encodeURIComponent(taskId)}`; }} />
        </div>
        <div hidden={route.screen !== "shell"}><StandaloneShell active={route.screen === "shell"}
          taskId={route.screen === "shell" ? route.taskId : undefined} /></div>
        {route.screen === "mission" && <TaskDetail key={route.taskId} taskId={route.taskId}
          onBack={() => { window.location.hash = "/overview"; }} />}
        {route.screen === "agents" && <><div className="application-heading"><h1>Agents</h1>
          <p>Configured environments and their observed capabilities. Missions route automatically.</p></div><Catalog /></>}
        {route.screen !== "overview" && route.screen !== "mission" && route.screen !== "shell" && route.screen !== "agents" &&
          <ApplicationWorkspace screen={route.screen} workspace={workspace} />}
      </main>
    </div>
  </div>;
}
