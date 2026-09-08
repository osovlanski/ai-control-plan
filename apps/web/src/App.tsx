import { useEffect, useState } from "react";
import { api, type Assistant, type CapabilityChange, type CatalogModel, type SchedulerStatus, type Workspace } from "./api.js";
import { NewTask } from "./NewTask.jsx";
import { TaskDetail } from "./TaskDetail.jsx";
import { OrbitalBoard } from "./OrbitalBoard.js";
import { Button, Card, QuotaBar, tokens } from "./ui.jsx";
import { onAuthExpired } from "./auth.js";

type View =
  | { screen: "board" }
  | { screen: "new"; goal?: string }
  | { screen: "task"; taskId: string }
  | { screen: "catalog" };

const NAV: Array<{ screen: View["screen"]; label: string; icon: string }> = [
  { screen: "board", label: "Orbital", icon: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4.5v9M7.5 12h9" },
  { screen: "new", label: "Intake", icon: "M12 5v14M5 12h14" },
  { screen: "catalog", label: "Agents", icon: "M5 7h14M5 12h14M5 17h9M17 15l2 2 3-3" },
];

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
  const [view, setView] = useState<View>({ screen: "board" });
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);

  useEffect(() => onAuthExpired(() => setExpired(true)), []);

  useEffect(() => {
    api.workspace().then(setWorkspace).catch((e: Error) => setError(e.message));
  }, []);

  if (expired)
    return (
      <div className="os-expired">
        <div className="os-environment" aria-hidden="true" />
        <h1>
          Session expired — re-open with <code>pnpm --filter @agent-plane/api open</code>
        </h1>
      </div>
    );
  return (
    <div className="os-shell">
      <div className="os-environment" aria-hidden="true" />
      <aside className="os-rail">
        <div className="os-mark" aria-hidden="true" />
        <nav aria-label="System">
          {NAV.map((n) => (
            <button
              key={n.screen}
              className="os-nav"
              aria-current={view.screen === n.screen || (n.screen === "board" && view.screen === "task") ? "page" : undefined}
              onClick={() => setView({ screen: n.screen } as View)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d={n.icon} />
              </svg>
              {n.label}
            </button>
          ))}
        </nav>
        <span className="os-rail-foot">Agentic OS</span>
      </aside>
      <div className="os-main">
        <header className="os-topbar">
          <div className="os-brand">
            <strong>Agentic OS</strong>
            <span>Agent Control Plane</span>
          </div>
          {workspace && <span className="os-workspace">{workspace.workspace}</span>}
          <SystemHealth />
        </header>
        <main>
          {error && <p className="error">API unreachable: {error}</p>}
          {view.screen === "board" && (
            <OrbitalBoard
              onOpen={(taskId) => setView({ screen: "task", taskId })}
              onNew={(goal) => setView({ screen: "new", goal })}
            />
          )}
          {view.screen === "new" && (
            <NewTask initialGoal={view.goal} onStarted={(taskId) => setView({ screen: "task", taskId })} />
          )}
          {view.screen === "task" && <TaskDetail taskId={view.taskId} onBack={() => setView({ screen: "board" })} />}
          {view.screen === "catalog" && <Catalog />}
        </main>
      </div>
    </div>
  );
}

/**
 * K7 model catalog card: evidence with its provenance, never a ranking. The
 * catalog says what is known about a model; provider discovery (above) remains
 * the authority for which assistant can serve it.
 */
function ModelCatalogCard() {
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    void api.models().then((r) => { setModels(r.models); setError(null); })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };
  useEffect(load, []);

  const refresh = async () => {
    setBusy(true);
    try { await api.refreshModels(); load(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  return (
    <Card>
      <div style={{ display: "flex", alignItems: "center", gap: "0.7rem" }}>
        <strong>Model catalog</strong>
        <span style={{ fontSize: "0.8rem", color: tokens.muted }}>identity + price evidence (K7)</span>
        <span style={{ marginLeft: "auto" }}>
          <Button variant="secondary" onClick={() => void refresh()} disabled={busy}>
            {busy ? "Refreshing…" : "Refresh"}
          </Button>
        </span>
      </div>
      {error && <p style={{ margin: "0.6rem 0 0", fontSize: "0.85rem", color: tokens.muted }}>Catalog unavailable: {error}. Routing is unaffected.</p>}
      {!error && models.length === 0 && (
        <p style={{ margin: "0.6rem 0 0", fontSize: "0.85rem", color: tokens.muted }}>
          No catalog evidence yet — refresh to collect it from provider discovery and this workspace’s own runs.
        </p>
      )}
      {models.map((m) => (
        <div key={m.modelId} style={{ marginTop: "0.6rem", fontSize: "0.83rem" }}>
          <strong>{m.modelId}</strong>{" "}
          <span style={{ color: tokens.muted }}>
            {m.provider} · {m.provenance.tier} via {m.provenance.source} · {m.freshness}
            {m.contextWindowTokens ? ` · ctx ${m.contextWindowTokens}` : ""}
            {m.availableVia.length ? ` · via ${m.availableVia.join(", ")}` : " · no assistant advertises it"}
          </span>
          {m.pricing.map((p) => (
            <div key={p.pricingVersion} style={{ color: tokens.muted }}>
              price {p.inputPerMtok}/{p.outputPerMtok} {p.currency} per Mtok · version {p.pricingVersion} · {p.provenance.tier}
              {p.appliesTo ? ` · applies to ${p.appliesTo.servingProvider}${p.appliesTo.accountKind ? `/${p.appliesTo.accountKind}` : ""}` : " · applicability not established"}
              {" · evidence only, not an enforcement tariff"}
            </div>
          ))}
        </div>
      ))}
    </Card>
  );
}

function Catalog() {
  const [assistants, setAssistants] = useState<Assistant[]>([]);
  const [cooldowns, setCooldowns] = useState<Array<{ assistantId: string; reason: string; until: string }>>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [changes, setChanges] = useState<CapabilityChange[]>([]);

  const load = () => {
    void api.assistants().then(setAssistants);
    void api.cooldowns().then(setCooldowns);
    void api.changes().then(setChanges);
  };
  useEffect(() => { load(); const timer = setInterval(load, 60_000); return () => clearInterval(timer); }, []);

  const sync = async (id: string) => {
    setBusy(id);
    try {
      await api.syncAssistant(id);
      load();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ display: "grid", gap: "0.8rem" }}>
      <Card><strong>What changed today</strong>{changes.filter((c) => Date.now() - Date.parse(c.observed_at) < 86400000).length === 0 ? <p style={{ color: tokens.muted }}>No capability changes observed today.</p> : changes.filter((c) => Date.now() - Date.parse(c.observed_at) < 86400000).map((c, i) => <p key={i} style={{ fontSize: "0.83rem" }}><strong>{c.assistant_id}</strong>: {c.field} — {c.old_value || "(none)"} → {c.new_value || "(none)"}</p>)}</Card>
      {assistants.map((a) => {
        const core = a.manifest?.core;
        const cooldown = cooldowns.find(
          (c) => c.assistantId === a.id && Date.parse(c.until) > Date.now(),
        );
        return (
          <Card key={a.id} style={cooldown ? { borderColor: `${tokens.warn}66` } : undefined}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.7rem" }}>
              <strong style={{ fontSize: "0.95rem" }}>{a.id}</strong>
              <span style={{ fontSize: "0.8rem", color: tokens.muted }}>{a.provider}</span>
              {core && (
                <span
                  style={{
                    fontSize: "0.78rem",
                    color: core.auth.state === "ok" ? tokens.ok : tokens.danger,
                  }}
                >
                  auth: {core.auth.state}
                  {core.auth.account ? ` (${core.auth.account})` : ""}
                </span>
              )}
              <span style={{ marginLeft: "auto" }}>
                <Button variant="secondary" onClick={() => void sync(a.id)} disabled={busy === a.id}>
                  {busy === a.id ? "Syncing…" : "Sync"}
                </Button>
              </span>
            </div>
            {cooldown && (
              <p style={{ margin: "0.6rem 0 0", fontSize: "0.85rem", color: tokens.warn }}>
                Cooling down: {cooldown.reason} — routing will skip it until{" "}
                {new Date(cooldown.until).toLocaleTimeString()}.
              </p>
            )}
            {!core && (
              <p style={{ margin: "0.6rem 0 0", fontSize: "0.85rem", color: tokens.muted }}>
                No manifest yet — run a sync to discover capabilities.
              </p>
            )}
            {core && (
              <>
                <div style={{ marginTop: "0.6rem", fontSize: "0.83rem", color: tokens.muted }}>
                  models: {core.models.map((m) => m.id).join(", ") || "—"} · resume:{" "}
                  {String(core.canResume)} · mcp: {String(core.canMcp)} · reports limits:{" "}
                  <strong style={{ color: core.reportsLimits ? tokens.ok : tokens.warn }}>
                    {String(core.reportsLimits)}
                  </strong>{" "}
                  · mid-run input: {String(core.supportsMidRunInput)}
                </div>
                {core.limits?.map((l) => (
                  <div key={l.window} style={{ marginTop: "0.4rem" }}>
                    <QuotaBar usedPercent={l.usedPercent} resetsAt={l.resetsAt} />
                  </div>
                ))}
                {a.manifestUpdatedAt && (
                  <div style={{ marginTop: "0.5rem", fontSize: "0.78rem", color: tokens.muted }}>
                    last sync {new Date(a.manifestUpdatedAt).toLocaleString()}
                  </div>
                )}
              </>
            )}
          </Card>
        );
      })}
      <ModelCatalogCard />
    </div>
  );
}
