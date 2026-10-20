/**
 * M7 composition views. `DecisionView` renders one CompositionDecision (six stages, each with the
 * plane's own `why`) and the spec it would bind; `CompositionPanel` is the Task Detail tab. Both only
 * format what the plane published. A derived number carries its method, and what the plane could not
 * supply reads `unknown`.
 */
import { useCallback, useEffect, useState } from "react";
import type { AgentSpec, AgentSpecDraft, ComposerOutcome, DecisionStage } from "@agent-plane/core";
import {
  ApiError, api,
  type CompositionAttempt, type CompositionBudget, type CompositionHistory,
} from "./api.js";
import {
  assetRows, boundRevisions, budgetLines, chosenRefs, fmtInt, fmtMs, fmtUsd, overrunText, rejectedRefs, runCost, runTokens,
  shortDigest, specRows, STAGE_LABELS, stageState, unboundRevisions,
  type Figure, type Method,
} from "./composition.js";

const FAILURE_HINT: Record<string, string> = {
  no_candidate: "no assistant passed the hard filters",
  policy_unenforceable: "no available adapter can enforce the approval mode this task needs",
  isolation_unavailable: "the workspace does not permit the isolation level that was requested",
  budget_exhausted: "the task has no budget left",
  override_refused: "an override would loosen policy or name something invalid",
  not_final: "the bundle renderer kept excluding a selected skill",
  disabled: "registry federation is off, so no bundle can be rendered",
  unreachable: "Cockpit could not be reached",
  unsupported_harness: "bundle v1 renders claude-code and codex only",
  no_snapshot: "no registry snapshot exists yet",
};
const hint = (reason: string | null | undefined) => (reason && FAILURE_HINT[reason] ? ` (${FAILURE_HINT[reason]})` : "");

/** `guessed` / `estimated` / `measured` / `unknown`: how the figure next to it was obtained. */
export function MethodTag({ method, title }: { method: Method; title?: string }) {
  return <span className={`method method-${method}`} {...(title ? { title } : {})}>{method}</span>;
}

function FigureText({ figure }: { figure: Figure }) {
  return <>
    <span className={figure.method === "unknown" ? "unknown-value" : undefined}>{figure.text}</span>
    {figure.method && <> <MethodTag method={figure.method} {...(figure.note ? { title: figure.note } : {})} /></>}
    {figure.note && <small className="comp-note"> {figure.note}</small>}
  </>;
}

function Digest({ value }: { value: string | null | undefined }) {
  return <code className="digest" title={value ?? "no digest recorded"}>{shortDigest(value)}</code>;
}

// ---- one decision ---------------------------------------------------------------------------

function StageItem({ stage, index }: { stage: DecisionStage; index: number }) {
  const state = stageState(stage);
  const chosen = chosenRefs(stage);
  const rejected = rejectedRefs(stage);
  const stateLabel = { chosen: "decided", empty: "nothing chosen", not_run: "not run", awaiting: "awaiting your confirmation" }[state];
  return (
    <li className={`comp-stage is-${state}`} data-stage={stage.stage}>
      <header>
        <span className="comp-stage-n" aria-hidden="true">{index + 1}</span>
        <h3>{STAGE_LABELS[stage.stage]}</h3>
        <span className={`comp-stage-state state-${state}`}>{stateLabel}</span>
        {stage.override && <span className="comp-override" title={stage.override.reason}>overridden by {stage.override.actor}</span>}
      </header>
      {chosen.length > 0 && (
        <ul className="comp-chosen" aria-label={`${STAGE_LABELS[stage.stage]} chosen`}>
          {chosen.map((c) => (
            <li key={c.ref}>
              <code>{c.ref}</code>
              {c.digest && <> <Digest value={c.digest} /></>}
              {c.evidence.map((e, i) => <small key={i}>{e}</small>)}
            </li>
          ))}
        </ul>
      )}
      <p className="comp-why"><span>why</span> {stage.why}</p>
      {stage.override && (
        <p className="comp-why"><span>overridden</span> from {stage.override.from.join(", ") || "nothing"} to {stage.override.to.join(", ") || "nothing"}</p>
      )}
      {state !== "awaiting" && (rejected.length > 0 || stage.filters.length > 0) && (
        <details className="comp-considered">
          <summary>Considered {stage.candidates.length}, not chosen {rejected.length}</summary>
          {stage.filters.map((f) => (
            <p key={f.filter} className="comp-filter"><code>{f.filter}</code> removed {f.removed.join(", ")}: {f.reason}</p>
          ))}
          <ul>
            {rejected.map((r) => (
              <li key={r.ref}><code>{r.ref}</code>{r.digest && <> <Digest value={r.digest} /></>}{r.filter && <small> removed by {r.filter}</small>}</li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

function SpecSummary({ spec }: { spec: AgentSpec | AgentSpecDraft }) {
  const rows = specRows(spec);
  const assets = assetRows(spec);
  const ctx = spec.context;
  return (
    <div className="comp-spec" aria-label="What this composition attaches and enforces">
      <h3 className="section-label">Attaches and enforces</h3>
      <dl className="comp-spec-grid">
        {rows.map((r) => (
          <div key={r.label}>
            <dt>{r.label}</dt>
            <dd {...(r.title ? { title: r.title } : {})}>
              <span className={r.method === "unknown" ? "unknown-value" : undefined}>{r.value}</span>
              {r.method && <> <MethodTag method={r.method} {...(r.title ? { title: r.title } : {})} /></>}
            </dd>
          </div>
        ))}
        <div>
          <dt>Registry snapshot</dt>
          <dd><Digest value={spec.registry.snapshot_digest} /> <small className="comp-note">observed {new Date(spec.registry.observed_at).toLocaleString()}</small>
            {spec.registry.stale && <> <span className="comp-stale">stale</span></>}</dd>
        </div>
        <div>
          <dt>Bundle digest</dt>
          <dd><Digest value={ctx.bundle_digest || undefined} /></dd>
        </div>
      </dl>
      <h3 className="section-label">Assets</h3>
      {assets.length === 0
        ? <p className="fine-print">No skill, MCP server or subagent is attached. Ambient tooling on the machine is not evidence of attachment.</p>
        : <ul className="comp-assets">
          {assets.map((a) => (
            <li key={`${a.kind}:${a.id}`}>
              <span className="comp-kind">{a.kind}</span> <code>{a.id}</code> <Digest value={a.digest} />
              {a.allowlisted && <small className="comp-note"> allowlisted</small>}
              {a.optIn && <small className="comp-note"> operator opt-in</small>}
            </li>
          ))}
        </ul>}
      {(ctx.fragments.length > 0 || ctx.memory_bundles.length > 0) && <>
        <h3 className="section-label">Context</h3>
        <ul className="comp-assets">
          {ctx.fragments.map((f) => <li key={`f:${f}`}><span className="comp-kind">fragment</span> <code>{f}</code></li>)}
          {ctx.memory_bundles.map((m) => <li key={`m:${m.id}`}><span className="comp-kind">memory</span> <code>{m.id}</code> <Digest value={m.digest} /> <small className="comp-note">{m.reason}</small></li>)}
        </ul>
      </>}
    </div>
  );
}

function OutcomeLine({ outcome, digest, resynced }: { outcome: ComposerOutcome; digest: string | null; resynced?: boolean }) {
  if (outcome.status === "composed") {
    return <p className="comp-outcome is-composed" role="status">Composed. <span>Digest</span> <Digest value={digest} />{resynced ? <small className="comp-note"> The registry was stale, so it was synced once and recomposed.</small> : null}</p>;
  }
  if (outcome.status === "skipped") {
    return <p className="comp-outcome is-skipped" role="status">Not composed: skipped, <code>{outcome.reason}</code>{hint(outcome.reason)}. A start runs on routing alone.</p>;
  }
  return <p className="comp-outcome is-failed" role="status">Not composed: <code>{outcome.reason}</code>{hint(outcome.reason)}{outcome.detail ? `, ${outcome.detail}` : ""}. A start runs on routing alone, or is refused when the plane requires a revision.</p>;
}

/** Six stages, the outcome and (when composed) the spec that would bind. */
export function DecisionView({ decision, outcome, spec, digest, resynced }: {
  decision: { stages: DecisionStage[] };
  outcome?: ComposerOutcome;
  spec?: AgentSpec | AgentSpecDraft | null;
  digest?: string | null;
  resynced?: boolean;
}) {
  return (
    <div className="composition" aria-label="Composition decision">
      {outcome && <OutcomeLine outcome={outcome} digest={digest ?? null} {...(resynced !== undefined ? { resynced } : {})} />}
      <ol className="comp-stages">
        {decision.stages.map((s, i) => <StageItem key={s.stage} stage={s} index={i} />)}
      </ol>
      {spec && <SpecSummary spec={spec} />}
    </div>
  );
}

// ---- budget ---------------------------------------------------------------------------------

function BudgetView({ budget }: { budget: CompositionBudget }) {
  const lines = budgetLines(budget);
  const runtime = budget.caps.max_runtime_ms;
  return (
    <div className="comp-budget">
      <table className="comp-table" aria-label="Task budget">
        <thead><tr><th scope="col">Budget</th><th scope="col">Cap</th><th scope="col">Consumed</th><th scope="col">Remaining</th></tr></thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.label}>
              <th scope="row">{l.label}</th>
              <td>{l.cap}</td>
              <td><FigureText figure={l.consumed} /></td>
              <td><FigureText figure={l.remaining} /></td>
            </tr>
          ))}
          <tr>
            <th scope="row">Runtime</th>
            <td>{runtime !== undefined ? `${fmtMs(runtime)} per run` : "no cap set"}</td>
            <td colSpan={2}><small className="comp-note">a per-run hard timeout, never consumed across runs</small></td>
          </tr>
        </tbody>
      </table>
      {budget.exhausted.length > 0 && <p className="error" role="alert">Exhausted: {budget.exhausted.join(", ")}. A dispatch parks the task until an operator raises the cap.</p>}
      {budget.latestRevision && (
        <p className="fine-print">
          Latest revision <code>{budget.latestRevision.compositionRevisionId}</code> runs under{" "}
          {budget.latestRevision.caps.max_tokens !== undefined ? `${fmtInt(budget.latestRevision.caps.max_tokens)} tokens` : "no token cap"}
          {budget.latestRevision.caps.max_cost_usd !== undefined ? `, ${fmtUsd(budget.latestRevision.caps.max_cost_usd)}` : ""}
          {" "}(what remained when it was composed).
        </p>
      )}
      {budget.provisional && <p className="fine-print">Provisional: usage records can still arrive for any run, and the figures settle to the larger of in-run usage and records, never their sum.</p>}
      {budget.runs.length > 0 && (
        <table className="comp-table" aria-label="Per-run settlement">
          <thead><tr><th scope="col">Run</th><th scope="col">Assistant · model</th><th scope="col">Tokens</th><th scope="col">Cost</th><th scope="col">Revision</th></tr></thead>
          <tbody>
            {budget.runs.map((r) => (
              <tr key={r.runId}>
                <th scope="row"><code>{r.runId}</code></th>
                <td>{r.assistantId} · {r.model ?? <span className="unknown-value">unknown model</span>}</td>
                <td><FigureText figure={runTokens(r)} />{r.regressed.length > 0 && <small className="comp-note"> {r.regressed.length} regressed record(s) ignored</small>}</td>
                <td><FigureText figure={runCost(r)} /></td>
                <td>{r.compositionRevisionId ? <code>{r.compositionRevisionId}</code> : <span className="unknown-value">none (routing only)</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {budget.overruns.length > 0 && (
        <ul className="comp-overruns" aria-label="Budget overruns">
          {budget.overruns.map((o) => <li key={`${o.runId}:${o.seq}`} className="error">{overrunText(o)} · run <code>{o.runId}</code></li>)}
        </ul>
      )}
    </div>
  );
}

function AttemptsTable({ attempts }: { attempts: CompositionAttempt[] }) {
  if (!attempts.length) return <p className="fine-print">No composition attempt recorded.</p>;
  return (
    <table className="comp-table" aria-label="Composition attempts">
      <thead><tr><th scope="col">Attempt</th><th scope="col">Origin</th><th scope="col">Outcome</th><th scope="col">Reason</th><th scope="col">Digest</th><th scope="col">Revision</th><th scope="col">At</th></tr></thead>
      <tbody>
        {attempts.map((a) => (
          <tr key={a.id}>
            <th scope="row"><code>{a.id}</code></th>
            <td>{a.origin}</td>
            <td><span className={`comp-attempt outcome-${a.outcome}`}>{a.outcome}</span></td>
            <td>{a.reason ?? "none"}</td>
            <td><Digest value={a.compositionDigest} /></td>
            <td>{a.compositionRevisionId ? <code>{a.compositionRevisionId}</code> : "none"}</td>
            <td><time dateTime={a.createdAt}>{new Date(a.createdAt).toLocaleString()}</time></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---- the Task Detail tab --------------------------------------------------------------------

type Read<T> = { state: "loading" } | { state: "ready"; value: T } | { state: "error"; message: string };
type Panel = { history: Read<CompositionHistory>; budget: Read<CompositionBudget>; off: boolean };

const failure = (e: unknown): Read<never> => ({ state: "error", message: e instanceof Error ? e.message : String(e) });
const isOff = (e: unknown) => e instanceof ApiError && e.reason === "composer_disabled";

/**
 * The bound revision, attempts and budget of one task. `runs` says which revision each run bound;
 * `refreshKey` changes when the task does, and the reads are repeated.
 */
export function CompositionPanel({ taskId, runs, refreshKey }: {
  taskId: string;
  runs: ReadonlyArray<{ id: string; compositionRevisionId?: string | null }>;
  refreshKey?: string;
}) {
  const [panel, setPanel] = useState<Panel>({ history: { state: "loading" }, budget: { state: "loading" }, off: false });
  const load = useCallback(() => {
    void Promise.allSettled([api.composition(taskId), api.compositionBudget(taskId)]).then(([h, b]) => {
      if ((h.status === "rejected" && isOff(h.reason)) || (b.status === "rejected" && isOff(b.reason))) {
        setPanel({ history: { state: "loading" }, budget: { state: "loading" }, off: true });
        return;
      }
      setPanel({
        off: false,
        history: h.status === "fulfilled" ? { state: "ready", value: h.value } : failure(h.reason),
        budget: b.status === "fulfilled" ? { state: "ready", value: b.value } : failure(b.reason),
      });
    });
  }, [taskId]);
  useEffect(() => { setPanel({ history: { state: "loading" }, budget: { state: "loading" }, off: false }); load(); }, [load, refreshKey]);

  if (panel.off) {
    return <p className="comp-off" role="status">The Composer is off for this workspace (<code>composer.enabled</code> is false), so this task has no composition revision and runs on routing alone.</p>;
  }
  const { history, budget } = panel;
  const bound = history.state === "ready" ? boundRevisions(history.value, runs) : [];
  const current = bound.at(-1);
  const earlier = bound.slice(0, -1);
  const stray = history.state === "ready" ? unboundRevisions(history.value, bound) : [];
  const lastAttempt = history.state === "ready" ? history.value.attempts.at(-1) : undefined;
  return (
    <div className="comp-panel">
      <div className="comp-panel-head">
        <button type="button" className="btn" onClick={load}>Refresh</button>
      </div>

      <h3 className="section-label">Bound revision</h3>
      {history.state === "loading" && <p role="status" className="fine-print">Reading composition…</p>}
      {history.state === "error" && <p role="alert" className="error">Composition unavailable: {history.message}</p>}
      {history.state === "ready" && !current && (
        <p className="comp-none" role="status">
          No composition revision is bound to this task{runs.length ? "'s runs" : ""}.{" "}
          {runs.length === 0
            ? "A preview is recorded as an attempt only; a revision is written when the task starts."
            : lastAttempt
              ? <>Latest attempt: <code>{lastAttempt.outcome}</code>{lastAttempt.reason ? <> (<code>{lastAttempt.reason}</code>{hint(lastAttempt.reason)})</> : null}. The run used routing alone.</>
              : "The run used routing alone."}
        </p>
      )}
      {current && (
        <section aria-label="Bound revision">
          <p className="comp-rev">
            <code>{current.revision.compositionRevisionId}</code> · bundle <Digest value={current.revision.bundleDigest} /> · composed {new Date(current.revision.createdAt).toLocaleString()} ·
            run{current.runIds.length === 1 ? "" : "s"} {current.runIds.map((id, i) => <span key={id}>{i ? ", " : " "}<code>{id}</code></span>)}
          </p>
          <DecisionView decision={current.revision.decision} spec={current.revision.spec} />
        </section>
      )}
      {earlier.length > 0 && (
        <details className="comp-earlier">
          <summary>{earlier.length} earlier revision{earlier.length === 1 ? "" : "s"} (wake, failover or handoff)</summary>
          {earlier.map((b) => (
            <section key={b.revision.compositionRevisionId} aria-label={`Revision ${b.revision.compositionRevisionId}`}>
              <p className="comp-rev"><code>{b.revision.compositionRevisionId}</code> · run{b.runIds.length === 1 ? "" : "s"} {b.runIds.join(", ")}</p>
              <DecisionView decision={b.revision.decision} spec={b.revision.spec} />
            </section>
          ))}
        </details>
      )}
      {stray.length > 0 && <p className="fine-print">{stray.length} persisted revision{stray.length === 1 ? " is" : "s are"} not bound to any run: {stray.map((r) => r.compositionRevisionId).join(", ")}.</p>}

      <h3 className="section-label">Budget</h3>
      {budget.state === "loading" && <p role="status" className="fine-print">Reading budget…</p>}
      {budget.state === "error" && <p role="alert" className="error">Budget unavailable: {budget.message}</p>}
      {budget.state === "ready" && <BudgetView budget={budget.value} />}

      <h3 className="section-label">Attempts</h3>
      {history.state === "ready" && <AttemptsTable attempts={history.value.attempts} />}

      {history.state === "ready" && history.value.optIns.length > 0 && <>
        <h3 className="section-label">Operator opt-ins</h3>
        <ul className="comp-assets">
          {history.value.optIns.map((o) => <li key={`${o.assetId}:${o.digest}`}><code>{o.assetId}</code> <Digest value={o.digest} /> <small className="comp-note">{o.actor}, {new Date(o.at).toLocaleString()}</small></li>)}
        </ul>
      </>}
    </div>
  );
}
