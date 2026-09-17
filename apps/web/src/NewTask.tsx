import { useState } from "react";
import { api, type RoutingExplanation } from "./api.js";
import { Button, Field, inputStyle, QuotaBar, tokens } from "./ui.jsx";

export function NewTask({ onStarted, onPreviewed }: { onStarted: (taskId: string) => void; onPreviewed: () => void }) {
  const [goal, setGoal] = useState("");
  const [constraints, setConstraints] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [profile, setProfile] = useState("auto");
  const [taskId, setTaskId] = useState<string | null>(null);
  const [explanation, setExplanation] = useState<RoutingExplanation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const invalidatePreview = () => {
    setTaskId(null);
    setExplanation(null);
  };

  const previewRoute = async () => {
    setError(null);
    setBusy(true);
    try {
      const created = taskId
        ? { taskId }
        : await api.createTask({
            goal,
            constraints: constraints
              .split("\n")
              .map((c) => c.trim())
              .filter(Boolean),
            repoPath: repoPath.trim() || undefined,
            profile,
          });
      setTaskId(created.taskId);
      setExplanation(await api.route(created.taskId));
      onPreviewed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const eligible = explanation?.candidates.filter((c) => c.passedFilters) ?? [];

  const startParallel = async (mode: "compare" | "race") => {
    if (!taskId) return;
    setError(null);
    setBusy(true);
    try {
      await api.startParallel(taskId, eligible.map((c) => c.assistantId), mode);
      onStarted(taskId);
      setGoal(""); setTaskId(null); setExplanation(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const start = async (assistantId?: string) => {
    if (!taskId) return;
    setError(null);
    setBusy(true);
    try {
      await api.start(taskId, assistantId);
      onStarted(taskId);
      setGoal(""); setTaskId(null); setExplanation(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="shell-intake">
      <form className="shell-composer" aria-label="Command" onSubmit={e => { e.preventDefault(); if (!busy && goal.trim()) void previewRoute(); }}>
        <label className="shell-goal-label" htmlFor="mission-goal">What should Agentic OS do?</label>
        <textarea id="mission-goal" aria-describedby="command-help" disabled={busy} value={goal}
          onChange={e => { setGoal(e.target.value); invalidatePreview(); }} rows={1}
          placeholder="What do you want Agentic OS to do?"
          onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); if (!busy && goal.trim()) void previewRoute(); } }} />
        <div className="shell-composer-actions">
          <span className="shell-auto">Automatic routing</span>
          <button className="btn btn-primary" type="submit" disabled={busy || !goal.trim()}>
            {busy ? "Preparing…" : taskId ? "Re-route" : "Preview routing"}
          </button>
        </div>
        <details className="shell-context">
          <summary>Context & constraints</summary>
          <div className="shell-context-fields">
            <Field label="Repository path (must be in the workspace allowlist)">
              <input disabled={busy} value={repoPath} onChange={e => { setRepoPath(e.target.value); invalidatePreview(); }} style={inputStyle} placeholder="/path/to/your/repository" />
            </Field>
            <Field label="Constraints (one per line)">
              <textarea disabled={busy} value={constraints} onChange={e => { setConstraints(e.target.value); invalidatePreview(); }} rows={2} style={inputStyle} placeholder="Keep the public API compatible" />
            </Field>
            <Field label="Routing profile">
              <select disabled={busy} value={profile} onChange={e => { setProfile(e.target.value); invalidatePreview(); }} style={inputStyle}>
                <option value="auto">Auto</option><option value="preserve-quota">Preserve Quota</option>
                <option value="fastest">Fastest (measured)</option><option value="best-quality">Best Quality (measured)</option>
                <option value="lowest-tokens">Lowest Tokens (measured)</option>
              </select>
            </Field>
            <p className="fine-print">Repository context is available. File upload, memory recall and per-mission tool selection are planned.</p>
          </div>
        </details>
        <p id="command-help" className="fine-print">Preview saves an unstarted mission. Edits need a new preview. Ctrl/⌘ + Enter to preview.</p>
        {error && <p role="alert" className="error">{error}</p>}
      </form>
      {explanation && <section className="shell-proposal" aria-label="Routing recommendation">
        <div className="shell-proposal-summary" role="status">
          <div><span className="eyebrow">Proposed route</span><h2>{explanation.chosen ?? "No eligible assistant"}</h2>
            <p>Rule fired: <code>{explanation.ruleFired}</code>{explanation.tieBreaker ? ` · ${explanation.tieBreaker}` : ""}</p>
            <p className="fine-print">The model will be reported when execution provides evidence.</p>
          </div>
          {explanation.chosen && <Button onClick={() => void start()} disabled={busy}>Run recommended</Button>}
        </div>
        <details className="shell-route-details"><summary>Routing evidence & advanced overrides</summary>
            {explanation.candidates.map((c) => (
              <div
                key={c.assistantId}
                style={{
                  padding: "0.7rem 0.8rem",
                  marginBottom: "0.6rem",
                  borderRadius: 8,
                  border: `1px solid ${c.assistantId === explanation.chosen ? tokens.accent : tokens.border}`,
                  background: c.assistantId === explanation.chosen ? `${tokens.accent}0a` : "transparent",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <strong style={{ fontSize: "0.92rem" }}>{c.assistantId}</strong>
                  {c.assistantId === explanation.chosen && (
                    <span style={{ fontSize: "0.75rem", color: tokens.accent, fontWeight: 600 }}>RECOMMENDED</span>
                  )}
                </div>
                {c.quota && <div style={{ marginTop: "0.4rem" }}><QuotaBar {...c.quota} /></div>}
                {c.filterFailures.length > 0 ? (
                  <ul style={{ margin: "0.4rem 0 0", paddingLeft: "1.1rem", fontSize: "0.8rem", color: tokens.danger }}>
                    {c.filterFailures.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                ) : (
                  <p style={{ margin: "0.4rem 0 0", fontSize: "0.8rem", color: tokens.ok }}>
                    passed all hard filters
                  </p>
                )}
                {c.passedFilters && c.assistantId !== explanation.chosen && (
                  <div style={{ marginTop: "0.5rem" }}>
                    <Button variant="secondary" onClick={() => void start(c.assistantId)} disabled={busy}>
                      Run on {c.assistantId} instead
                    </Button>
                  </div>
                )}
              </div>
            ))}
            {eligible.length > 1 && <div className="shell-parallel">
              <p className="fine-print">Parallel execution multiplies quota and token spend. Choose it deliberately.</p>
              <Button variant="secondary" disabled={busy} onClick={() => void startParallel("compare")}>Compare {eligible.length}</Button>
              <Button variant="secondary" disabled={busy} onClick={() => void startParallel("race")}>Race {eligible.length}</Button>
            </div>}
            {!explanation.chosen && <p className="error">No eligible assistant — every candidate failed a hard filter.</p>}
        </details>
      </section>}
    </div>
  );
}
