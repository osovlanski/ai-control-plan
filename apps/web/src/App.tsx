import { useEffect, useRef, useState } from "react";
import { api, type SchedulerStatus, type Workspace } from "./api.js";
import { TaskDetail } from "./TaskDetail.jsx";
import { OrbitalBoard } from "./OrbitalBoard.js";
import { onAuthExpired } from "./auth.js";
import { StandaloneShell } from "./shell/StandaloneShell.js";
import { Catalog } from "./shell/Agents.js";
import { ApplicationWorkspace } from "./shell/ApplicationWorkspace.js";
import { NAVIGATION, navigationScreen, readRoute, useShellRoute } from "./shell/routes.js";
import { ShellView } from "./shell-view/ShellView.js";
import { useOverviewView } from "./shell-view/viewMode.js";
import { About } from "./shell/About.js";

type NavItem = { screen: string; label: string; icon: string };

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

function NavLink({ item, current }: { item: NavItem; current: boolean }) {
  return <a className="os-nav" href={`#/${item.screen}`} aria-current={current ? "page" : undefined}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d={item.icon} /></svg>
    <span>{item.label}</span>
  </a>;
}

export function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [rawRoute] = useShellRoute();
  // Keep the legacy route and normalize the `#/mission` alias at the application boundary.
  const route = rawRoute.key === "mission" || rawRoute.key.startsWith("mission/")
    ? readRoute(`#/shell${rawRoute.key.slice("mission".length)}`) : rawRoute;
  const [view, setView] = useOverviewView();
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const main = useRef<HTMLElement>(null);
  const previousRoute = useRef(readRoute().key);
  const current = navigationScreen(route);
  const label = [...NAVIGATION.primary, ...NAVIGATION.system].find(n => n.screen === current)?.label ?? "Page unavailable";
  // Narrow screens show the daily destinations; the system group opens from More.
  const [more, setMore] = useState(false);
  const moreButton = useRef<HTMLButtonElement>(null);
  const inSystem = NAVIGATION.system.some(n => n.screen === current);
  useEffect(() => { setMore(false); }, [route.key]);

  useEffect(() => {
    document.documentElement.classList.toggle("shell-overview", route.screen === "overview" && view === "shell");
    return () => document.documentElement.classList.remove("shell-overview");
  }, [route.screen, view]);

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
  return <div className={`os-shell${route.screen === "shell" ? " is-shell-mode" : ""}`}>
    <a className="skip-link" href="#main-content" onClick={e => { e.preventDefault(); main.current?.focus(); }}>Skip to workspace</a>
    <div className="os-environment" aria-hidden="true" />
    <aside className="os-rail">
      <div className="os-identity"><div className="os-mark" aria-hidden="true" />
        <div><strong>Agentic <em>OS</em></strong><span>A workspace for AI work</span></div>
      </div>
      <nav aria-label="System" onKeyDown={e => {
        if (e.key === "Escape" && more) { setMore(false); moreButton.current?.focus(); }
      }}>
        <div className="os-nav-primary">
          {NAVIGATION.primary.map(n => <NavLink key={n.screen} item={n} current={current === n.screen} />)}
          <button type="button" ref={moreButton} className={`os-nav os-nav-more${inSystem ? " is-current" : ""}`}
            aria-expanded={more} aria-controls="os-nav-system" onClick={() => setMore(m => !m)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h.01M12 12h.01M19 12h.01" /></svg>
            <span>More</span>
          </button>
        </div>
        <div id="os-nav-system" className={`os-nav-system${more ? " is-open" : ""}`}>
          <span className="os-nav-group" aria-hidden="true">System</span>
          {NAVIGATION.system.map(n => <NavLink key={n.screen} item={n} current={current === n.screen} />)}
        </div>
      </nav>
      <div className="os-rail-foot"><span>Local workspace<br />You stay in command.</span></div>
    </aside>
    <div className="os-main">
      <header className="os-topbar">
        <div className="os-brand"><strong>{label}</strong><span>Agentic OS</span></div>
        {route.screen === "overview" && <div className="overview-toggle" role="group" aria-label="Overview view">
          <button type="button" aria-pressed={view === "orbit"} onClick={() => setView("orbit")}>Orbit</button>
          <button type="button" aria-pressed={view === "shell"} onClick={() => setView("shell")}>Shell</button>
        </div>}
        {workspace && <span className="os-workspace">{workspace.workspace}</span>}
        <SystemHealth />
      </header>
      <main id="main-content" tabIndex={-1} ref={main}>
        {error && <p className="error" role="alert">Workspace unavailable: {error}</p>}
        {/* Retain private in-memory drafts while navigating applications. */}
        <div hidden={route.screen !== "overview" || view !== "orbit"}>
          <OrbitalBoard active={route.screen === "overview" && view === "orbit"} onOpen={taskId => { window.location.hash = `/missions/${encodeURIComponent(taskId)}`; }} />
        </div>
        {route.screen === "overview" && view === "shell" && <ShellView active workspace={workspace?.workspace ?? null} repositories={workspace?.repoAllowlist ?? []}
          onOpen={taskId => { window.location.hash = `/missions/${encodeURIComponent(taskId)}`; }} />}
        <div hidden={route.screen !== "shell"}><StandaloneShell active={route.screen === "shell"}
          taskId={route.screen === "shell" ? route.taskId : undefined} /></div>
        {route.screen === "mission" && <TaskDetail key={route.taskId} taskId={route.taskId}
          onBack={() => { window.location.hash = "/overview"; }} />}
        {route.screen === "agents" && <><div className="application-heading"><h1>Agents</h1>
          <p>Configured environments and their observed capabilities. Missions route automatically.</p></div><Catalog /></>}
        {route.screen === "about" && <About />}
        {route.screen !== "overview" && route.screen !== "mission" && route.screen !== "shell" && route.screen !== "agents" && route.screen !== "about" &&
          <ApplicationWorkspace screen={route.screen} workspace={workspace} />}
      </main>
    </div>
  </div>;
}
