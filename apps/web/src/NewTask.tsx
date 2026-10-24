import { useId, useState } from "react";
import { ApiError, api, type CompositionPreview, type RoutingExplanation } from "./api.js";
import { DecisionView } from "./Composition.js";
import { Button, Field, inputStyle, QuotaBar, tokens } from "./ui.jsx";

/**
 * The composition shown next to the route. `off` is advertised by the plane (or a legacy 404 `composer_disabled`),
 * not a guess; `error` is any other failure and leaves routing usable.
 */
type Composition =
  | { state: "none" }
  | { state: "off" }
  | { state: "ready"; preview: CompositionPreview }
  | { state: "error"; message: string };

export const composeFor = async (taskId: string, assistantId?: string): Promise<Composition> => {
  const workspace = await api.workspace().catch(() => undefined);
  if (workspace?.composer?.enabled === false) return { state: "off" };
  try {
    return { state: "ready", preview: await api.compose(taskId, assistantId) };
  } catch (e) {
    if (e instanceof ApiError && e.reason === "composer_disabled") return { state: "off" };
    return { state: "error", message: (e as Error).message };
  }
};

export function NewTask({ onStarted, onPreviewed }: { onStarted: (taskId: string) => void; onPreviewed: () => void }) {
  const inputId = useId();
  const helpId = useId();
  const [goal, setGoal] = useState("");
  const [constraints, setConstraints] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [profile, setProfile] = useState("auto");
  const [taskId, setTaskId] = useState<string | null>(null);
  const [explanation, setExplanation] = useState<RoutingExplanation | null>(null);
  const [composition, setComposition] = useState<Composition>({ state: "none" });
  /** The assistant the operator asked to compose on instead of the recommended one. */
  const [target, setTarget] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const invalidatePreview = () => {
    setTaskId(null);
    setExplanation(null);
    setComposition({ state: "none" });
    setTarget(undefined);
    setNotice(null);
  };
  const reset = () => { setGoal(""); invalidatePreview(); };

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
      setTarget(undefined);
      setNotice(null);
      // The composition preview routes the task itself and records that decision, so it is read back
      // rather than routed a second time. With the composer off, routing is all there is.
      const composed = await composeFor(created.taskId);
      setComposition(composed);
      const recorded = composed.state === "ready" && composed.preview.routingDecisionId !== null
        ? (await api.routing(created.taskId)).at(-1)?.explanation
        : undefined;
      setExplanation(recorded ?? await api.route(created.taskId));
      onPreviewed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const eligible = explanation?.candidates.filter((c) => c.passedFilters) ?? [];
  const composed = composition.state === "ready" && composition.preview.outcome.status === "composed" ? composition.preview : null;

  const startParallel = async (mode: "compare" | "race") => {
    if (!taskId) return;
    setError(null);
    setBusy(true);
    try {
      await api.startParallel(taskId, eligible.map((c) => c.assistantId), mode);
      onStarted(taskId);
      reset();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** Runs what was previewed. With a composition, the digest the operator saw is what the plane must reproduce. */
  const start = async (assistantId?: string) => {
    if (!taskId) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await api.start(taskId, assistantId ?? target, composed?.compositionDigest ?? undefined);
      onStarted(taskId);
      reset();
    } catch (e) {
      if (e instanceof ApiError && e.reason === "composition_drift") {
        // The plane re-ran the pipeline and got a different answer. Nothing started; show the new one.
        const fresh = (e.body as { preview?: CompositionPreview }).preview;
        if (fresh) setComposition({ state: "ready", preview: fresh });
        setNotice("The composition changed since you previewed it, so nothing started. Review the new decision, then run again.");
      } else {
        setError((e as Error).message);
      }
    } finally {
      setBusy(false);
    }
  };

  /** Composes on another assistant and shows it, so the operator confirms what will really run. */
  const composeOn = async (assistantId: string, recommended = false) => {
    if (!taskId) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      // The recommended route is composed without an override, so it is the plane's own choice again.
      setComposition(await composeFor(taskId, recommended ? undefined : assistantId));
      setTarget(recommended ? undefined : assistantId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="shell-intake">
      <form className="shell-composer" aria-label="Command" onSubmit={e => { e.preventDefault(); if (!busy && goal.trim()) void previewRoute(); }}>
        <label className="shell-goal-label" htmlFor={inputId}>What should Agentic OS do?</label>
        <textarea id={inputId} aria-describedby={helpId} disabled={busy} value={goal}
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
        <p id={helpId} className="fine-print">Preview saves an unstarted mission. Edits need a new preview. Ctrl/⌘ + Enter to preview.</p>
        {error && <p role="alert" className="error">{error}</p>}
      </form>
      {explanation && <section className="shell-proposal" aria-label="Routing recommendation">
        <div className="shell-proposal-summary" role="status">
          <div><span className="eyebrow">Proposed route</span><h2>{explanation.chosen ?? "No eligible assistant"}</h2>
            <p>Rule fired: <code>{explanation.ruleFired}</code>{explanation.tieBreaker ? ` · ${explanation.tieBreaker}` : ""}</p>
            {target && <p>You chose to compose on <strong>{target}</strong> instead of the recommended route; "Run composed" runs it there.</p>}
            {composed?.specDraft
              ? <p className="fine-print">Requested model <code>{composed.specDraft.model.primary.id}</code>. The model that served the run is reported when execution provides evidence.</p>
              : <p className="fine-print">The model will be reported when execution provides evidence.</p>}
          </div>
          {explanation.chosen && <Button onClick={() => void start()} disabled={busy}>{composed ? "Run composed" : "Run recommended"}</Button>}
        </div>
        {notice && <p role="alert" className="shell-drift">{notice}</p>}
        {composition.state === "off" && <p className="fine-print shell-composer-off">Composer is off for this workspace (<code>composer.enabled</code>): routing only, no composition is recorded.</p>}
        {composition.state === "error" && <p role="alert" className="error">Composition preview unavailable: {composition.message}</p>}
        {composition.state === "ready" && (
          <section className="shell-composition" aria-label="Composition preview">
            <div className="shell-composition-head">
              <span className="eyebrow">Composition{target ? ` on ${target}` : ""}</span>
              <span className="fine-print">Six stages, each with the plane's reason. Nothing is attached until you run.</span>
            </div>
            <DecisionView decision={composition.preview.decision} outcome={composition.preview.outcome}
              spec={composition.preview.specDraft} digest={composition.preview.compositionDigest} resynced={composition.preview.resynced} />
          </section>
        )}
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
                {c.assistantId === explanation.chosen && target !== undefined && (
                  <div style={{ marginTop: "0.5rem" }}>
                    <Button variant="secondary" onClick={() => void composeOn(c.assistantId, true)} disabled={busy}>
                      Compose on {c.assistantId} (recommended) again
                    </Button>
                  </div>
                )}
                {c.passedFilters && c.assistantId !== explanation.chosen && (
                  <div style={{ marginTop: "0.5rem" }}>
                    {composition.state === "ready"
                      ? <Button variant="secondary" onClick={() => void composeOn(c.assistantId)} disabled={busy || target === c.assistantId}>
                        {target === c.assistantId ? `Composed on ${c.assistantId}` : `Compose on ${c.assistantId} instead`}
                      </Button>
                      : <Button variant="secondary" onClick={() => void start(c.assistantId)} disabled={busy}>
                        Run on {c.assistantId} instead
                      </Button>}
                  </div>
                )}
              </div>
            ))}
            {eligible.length > 1 && <div className="shell-parallel">
              <p className="fine-print">Parallel execution runs multiple candidates. Choose it deliberately.</p>
              <p className="fine-print">{composition.state === "off" || !repoPath.trim()
                ? "Compare and Race start on routing only because the Composer is off or this task has no repository."
                : composition.state === "ready"
                  ? "Compare and Race compose a separate revision and profile for each candidate, each with an equal share of the remaining task token and cost budget. Runtime limits apply per run."
                  : "With the Composer enabled and a repository, Compare and Race compose a separate revision and profile for each candidate, each with an equal share of the remaining task token and cost budget. Otherwise they start on routing only."} The previewed composition does not bind these runs.</p>
              <Button variant="secondary" disabled={busy} onClick={() => void startParallel("compare")}>Compare {eligible.length}</Button>
              <Button variant="secondary" disabled={busy} onClick={() => void startParallel("race")}>Race {eligible.length}</Button>
            </div>}
            {!explanation.chosen && <p className="error">No eligible assistant — every candidate failed a hard filter.</p>}
        </details>
      </section>}
    </div>
  );
}
