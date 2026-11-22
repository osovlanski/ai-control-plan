/**
 * qcq-03: the plane's ADVISORY run estimate and scheduling recommendation in task detail, and
 * (qcq-02) what was shown at each run's start beside what the run then recorded.
 *
 * Read-only. Every figure is printed as served by `GET /api/tasks/:id/estimate` and
 * `GET /api/tasks/:id/estimates/recorded`; nothing here recomputes a range, a confidence or a
 * window. API spend, the API-equivalent of subscription tokens and the subscription quota are
 * three labelled rows: API-equivalent dollars are never spend.
 */
import { useEffect, useState } from "react";
import type { EstimateRange, RunEstimate } from "@agent-plane/core";
import { api, type RecordedEstimates, type TaskEstimate as Estimate } from "./api.js";

const minutes = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)} min`);
const count = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)));
const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;
const range = (r: EstimateRange | null, f: (n: number) => string) => (r ? `${f(r.low)} / ${f(r.typical)} / ${f(r.high)}` : "unknown");
const actionLabels: Record<string, string> = {
  "run-now": "Run now",
  "run-in-window": "Run in a later window",
  "wait-for-approval": "Wait for approval",
  "wait-for-quota-reset": "Wait for the quota reset",
};

/** Pure: pending approvals, and how often comparable runs waited (with how long, only when some did). */
export function approvalText(a: RunEstimate["approvalWait"]): string {
  const parts = [`${a.pending} pending`];
  if (a.required) parts.push("one required before start");
  if (a.historicalShare !== null) {
    const pct = Math.round(a.historicalShare * 100);
    parts.push(pct === 0 ? "no comparable run waited" : `${pct}% of comparable runs waited ${range(a.historicalMs, minutes)}`);
  }
  return parts.join(" · ");
}

/** Pure: the three spend rows, labelled apart. Exported for the unit test. */
export function spendRows(spend: RunEstimate["spend"]): Array<[string, string]> {
  const q = spend.subscriptionQuota;
  return [
    ["Billing", `${spend.billing} (${spend.billingBasis})`],
    ["API spend", spend.billing === "api" ? range(spend.apiUsd, usd) : "n/a (not API-billed)"],
    ["API-equivalent (not spend)", spend.billing === "subscription" ? range(spend.apiEquivalentUsd, usd) : "n/a (not subscription-billed)"],
    ["Subscription quota", q ? `${q.bucket ?? "bucket"} at ${q.usedPercent}%${q.resetsAt ? `, resets ${new Date(q.resetsAt).toLocaleString()}` : ""}; per-run share ${q.perRunShare}` : "no fresh observation"],
  ];
}

function Rows({ rows, label }: { rows: Array<[string, string]>; label: string }) {
  return (
    <dl className="identity-grid" aria-label={label}>
      {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
    </dl>
  );
}

function CurrentEstimate({ e }: { e: Estimate }) {
  const { estimate: est, recommendation: rec } = e;
  const s = est.subject;
  return (
    <section aria-label="Run estimate">
      <h3>Estimate for the next run <span className="fine-print">(advisory, as of <time dateTime={est.asOf}>{new Date(est.asOf).toLocaleTimeString()}</time>)</span></h3>
      <p className="fine-print">
        {est.estimatorVersion} · confidence <strong>{est.confidence}</strong> · cohort {est.evidence.cohort}, {est.evidence.sampleSize} run(s)
        {" · "}hours {e.policy.timezone}
      </p>
      <Rows label="Estimate subject" rows={[
        ["Runtime", `${s.assistantId ?? "no eligible assistant"}${s.provider ? ` (${s.provider})` : ""}`],
        ["Model", `${s.model ?? "assistant default"} · ${s.modelSource}`],
        ["Effort", `${s.effort ?? "unknown"} · ${s.effortSource}`],
      ]} />
      <div className="section-label">Ranges: low / typical / high</div>
      <Rows label="Estimate ranges" rows={[
        ["Duration", range(est.durationMs.range, minutes)],
        ["Tokens in", range(est.tokens.input, count)],
        ["Tokens out", range(est.tokens.output, count)],
        ["Wait until start", range(est.waitUntilStartMs.range, minutes)],
        ["Approval wait", approvalText(est.approvalWait)],
      ]} />
      <div className="section-label">Spend</div>
      <Rows label="Estimate spend" rows={spendRows(est.spend)} />
      <section aria-label="Scheduling recommendation">
        <h3>Recommendation: {actionLabels[rec.action] ?? rec.action}</h3>
        <p className="fine-print">
          {rec.startAt ? <>Start <time dateTime={rec.startAt}>{new Date(rec.startAt).toLocaleString()}</time> · </> : null}
          speed weight {rec.speedWeight}
          {rec.window ? ` · ${rec.window.kind} window ${rec.window.localStart} to ${rec.window.localEnd}` : ""}
        </p>
        <ul className="fine-print">{rec.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
        <p className="fine-print">Advisory: this changes none of {rec.unchanged.join(", ")}.</p>
      </section>
      {est.evidence.missing.length > 0 && (
        <details>
          <summary>Missing evidence ({est.evidence.missing.length})</summary>
          <ul className="fine-print">{est.evidence.missing.map((m) => <li key={m}>{m}</li>)}</ul>
        </details>
      )}
    </section>
  );
}

function Recorded({ r }: { r: RecordedEstimates }) {
  return (
    <section aria-label="Recorded estimates">
      <h3>Shown at start, and what happened</h3>
      {r.records.length === 0 ? <p className="fine-print">No estimate recorded for this task's runs.</p> : (
        <table className="fine-print" style={{ borderSpacing: "0.75rem 0.25rem", marginLeft: "-0.75rem" }}>
          <thead><tr><th>Run</th><th>Shown duration</th><th>Actual</th><th>Shown tokens in / out (typical)</th><th>Actual tokens</th></tr></thead>
          <tbody>
            {r.records.map((x) => (
              <tr key={x.runId}>
                <td><span className="mono">{x.runId}</span> · {x.assistantId} · {x.estimate.confidence}</td>
                <td>{range(x.estimate.durationMs.range, minutes)}</td>
                <td>{x.actual ? `${minutes(x.actual.durationMs)} · ${x.actual.state}` : "not ended"}</td>
                <td>{x.estimate.tokens.input ? count(x.estimate.tokens.input.typical) : "unknown"} / {x.estimate.tokens.output ? count(x.estimate.tokens.output.typical) : "unknown"}</td>
                <td>{x.actual?.tokens ? `${count(x.actual.tokens.input)} / ${count(x.actual.tokens.output)}` : x.actual ? "not recorded" : "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function TaskEstimate({ taskId, refreshKey }: { taskId: string; refreshKey: string }) {
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [recorded, setRecorded] = useState<RecordedEstimates | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    void Promise.allSettled([api.estimate(taskId), api.recordedEstimates(taskId)]).then(([e, r]) => {
      if (!live) return;
      setEstimate(e.status === "fulfilled" ? e.value : null);
      setRecorded(r.status === "fulfilled" ? r.value : null);
      setErrors([e.status === "rejected" ? "Estimate" : "", r.status === "rejected" ? "Recorded estimates" : ""].filter(Boolean));
    });
    return () => { live = false; };
  }, [taskId, refreshKey]);
  return (
    <section className="task-estimate" aria-label="Task estimate">
      {errors.length > 0 && <p role="status" className="error">{errors.join(" and ")} unavailable in this read.</p>}
      {estimate && <CurrentEstimate e={estimate} />}
      {recorded && <Recorded r={recorded} />}
    </section>
  );
}
