import { useEffect, useState } from "react";
import { api, type Assistant, type CapabilityChange, type TaskSummary, type Workspace } from "./api.js";
import { NewTask } from "./NewTask.jsx";
import { TaskDetail } from "./TaskDetail.jsx";
import { Button, Card, QuotaBar, StateBadge, tokens } from "./ui.jsx";

type View = { screen: "board" } | { screen: "new" } | { screen: "task"; taskId: string } | { screen: "catalog" };

export function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [view, setView] = useState<View>({ screen: "board" });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.workspace().then(setWorkspace).catch((e: Error) => setError(e.message));
  }, []);

  return (
    <div style={{ minHeight: "100vh", background: tokens.bg, color: tokens.text }}>
      <header
        style={{
          borderBottom: `1px solid ${tokens.border}`,
          background: tokens.surface,
          padding: "0.9rem 1.5rem",
          display: "flex",
          alignItems: "center",
          gap: "1rem",
        }}
      >
        <strong style={{ fontSize: "0.98rem" }}>Agent Control Plane</strong>
        {workspace && (
          <span
            style={{
              padding: "0.15rem 0.6rem",
              borderRadius: 999,
              fontSize: "0.78rem",
              fontWeight: 600,
              background: `${tokens.accent}14`,
              color: tokens.accent,
              border: `1px solid ${tokens.accent}33`,
            }}
          >
            {workspace.workspace}
          </span>
        )}
        <nav style={{ marginLeft: "auto", display: "flex", gap: "0.4rem" }}>
          <Button variant={view.screen === "board" ? "primary" : "secondary"} onClick={() => setView({ screen: "board" })}>
            Board
          </Button>
          <Button variant={view.screen === "new" ? "primary" : "secondary"} onClick={() => setView({ screen: "new" })}>
            New task
          </Button>
          <Button
            variant={view.screen === "catalog" ? "primary" : "secondary"}
            onClick={() => setView({ screen: "catalog" })}
          >
            Assistants
          </Button>
        </nav>
      </header>

      <main style={{ maxWidth: 1080, margin: "0 auto", padding: "1.5rem" }}>
        {error && <p style={{ color: tokens.danger }}>API unreachable: {error}</p>}
        {view.screen === "board" && <Board onOpen={(taskId) => setView({ screen: "task", taskId })} />}
        {view.screen === "new" && <NewTask onStarted={(taskId) => setView({ screen: "task", taskId })} />}
        {view.screen === "task" && (
          <TaskDetail taskId={view.taskId} onBack={() => setView({ screen: "board" })} />
        )}
        {view.screen === "catalog" && <Catalog />}
      </main>
    </div>
  );
}

function Board({ onOpen }: { onOpen: (taskId: string) => void }) {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);

  useEffect(() => {
    const load = () => void api.tasks().then(setTasks);
    load();
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  }, []);

  if (tasks.length === 0) {
    return (
      <Card>
        <p style={{ margin: 0, color: tokens.muted }}>
          No tasks yet. Start one from <strong>New task</strong> — the router will explain its choice before anything runs.
        </p>
      </Card>
    );
  }

  return (
    <div style={{ display: "grid", gap: "0.7rem" }}>
      {tasks.map((t) => (
        <Card key={t.id} style={{ cursor: "pointer" }}>
          <div onClick={() => onOpen(t.id)}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.7rem" }}>
              <code style={{ fontFamily: tokens.mono, fontSize: "0.85rem" }}>{t.id}</code>
              <StateBadge state={t.state} />
              {t.phase && <span style={{ fontSize: "0.8rem", color: tokens.muted }}>{t.phase}</span>}
              <span style={{ marginLeft: "auto", fontSize: "0.78rem", color: tokens.muted }}>
                {new Date(t.updatedAt).toLocaleString()}
              </span>
            </div>
            <p style={{ margin: "0.5rem 0 0", fontSize: "0.92rem" }}>{t.goal}</p>
          </div>
        </Card>
      ))}
    </div>
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
    </div>
  );
}
