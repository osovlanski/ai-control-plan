/**
 * tlm-03 (Web half): where each run of a task came from, and the GitHub issues and PRs the task
 * belongs to, in task detail.
 *
 * Read-only. Reads `GET /api/tasks/:id/provenance` (tlm-02a, API 2.12) and
 * `GET /api/tasks/:id/links` (tlm-02b, API 2.13) through the shared `api` client and prints them
 * as served: every join was made on the plane and carries its source, and nothing here joins two
 * records itself. A join with a stored key names that key; an `inferred` join is labelled as a
 * guess beside the plane's stated rule; an `unrecorded` one stays unknown. The CLI side of the
 * same read is `aos task provenance` (#231), which uses the same labels.
 */
import { useEffect, useState } from "react";
import {
  api, type HandoffProvenance, type ProvenanceContinuation, type ProvenanceJoinSource, type RunProvenance,
  type TaskLink, type TaskLinkEvidence, type TaskLinks, type TaskProvenance as Provenance,
} from "./api.js";

const SOURCES: readonly ProvenanceJoinSource[] = ["execution_request", "dispatch", "handoff_record", "handoff_envelope", "checkpoint", "inferred", "unrecorded"];

/**
 * A shape check, not a contract validator (tlm-02a ships none): a plane older than API 2.12, or a
 * body of another shape, is refused instead of shown as if it were provenance. Mirrors the CLI's.
 */
export function provenanceProblem(body: unknown, taskId: string): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "not an object";
  const p = body as Partial<Provenance>;
  if (p.taskId !== taskId) return `taskId is ${JSON.stringify(p.taskId)}`;
  if (!Array.isArray(p.runs)) return "runs is not a list";
  if (!Array.isArray(p.handoffs)) return "handoffs is not a list";
  if (typeof p.owner !== "object" || p.owner === null) return "owner is missing";
  if (typeof p.inferenceRules !== "object" || p.inferenceRules === null) return "inferenceRules is missing";
  for (const r of p.runs) {
    if (typeof r?.runId !== "string" || !r.routingDecision || !SOURCES.includes(r.routingDecision.source)) return `run ${JSON.stringify(r?.runId)} has no labelled routing decision`;
    if (r.continuedFrom && !SOURCES.includes(r.continuedFrom.source)) return `run ${r.runId} has an unlabelled continuation`;
  }
  for (const h of p.handoffs) {
    if (typeof h?.id !== "string" || !h.from || !SOURCES.includes(h.from.source)) return `handoff ${JSON.stringify(h?.id)} has no labelled source run`;
  }
  return null;
}

/** How a join is labelled: a stored key is named, a guess is called a guess. Same words as the CLI. */
export function joinLabel(source: ProvenanceJoinSource): { text: string; kind: "key" | "inferred" | "unrecorded" } {
  if (source === "inferred") return { text: "INFERRED", kind: "inferred" };
  if (source === "unrecorded") return { text: "UNRECORDED", kind: "unrecorded" };
  return { text: `via ${source}`, kind: "key" };
}

/** Pure: how the run was started, from the served `launch`. */
export function launchText(r: RunProvenance): string {
  const l = r.launch;
  switch (l.kind) {
    case "scheduler": return `Scheduler dispatch ${l.dispatch?.id ?? "-"} (origin ${l.dispatch?.origin ?? "-"}, phase ${l.dispatch?.phase ?? "-"}, generation ${l.dispatch?.generation ?? "-"})`;
    case "handoff": return `Handoff (trigger ${l.handoffTrigger ?? "-"})`;
    case "parallel": return "Compare/race candidate";
    default: return "Operator start";
  }
}

/** Pure: one line per piece of link evidence. An operator link is a claim, never checked against GitHub. */
export function evidenceText(e: TaskLinkEvidence): string {
  switch (e.source) {
    case "operator":
      return `Operator claim: ${e.relation}${e.note ? ` (${e.note})` : ""}${e.createdBy ? ` by ${e.createdBy}` : ""} · not checked against GitHub`;
    case "autopilot_publication":
      return `Autopilot publication ${e.publicationId} (${e.state}) · ${e.head} → ${e.base} · verified ${e.verifiedSha.slice(0, 12)}`;
    case "autopilot_duplicate":
      return `Autopilot found an existing PR (${e.prState}) for publication ${e.publicationId}`;
  }
}

/** The join sources this body uses, so the rules are shown only when a join relies on them. */
export function sourcesUsed(p: Provenance): Set<ProvenanceJoinSource> {
  const used = new Set<ProvenanceJoinSource>();
  for (const r of p.runs) {
    used.add(r.routingDecision.source);
    if (r.continuedFrom) used.add(r.continuedFrom.source);
  }
  for (const h of p.handoffs) used.add(h.from.source);
  return used;
}

/** `routingDecision` → `Routing decision`: the served rule key, spaced for reading. */
export const ruleName = (key: string) => {
  const spaced = key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

const or = (v: string | number | null | undefined, none = "-") => (v === null || v === undefined || v === "" ? none : String(v));
const time = (iso: string) => <time dateTime={iso}>{new Date(iso).toLocaleString()}</time>;
const runRef = (id: string | null, assistant: string | null) =>
  id ? <><span className="mono">{id}</span>{assistant ? ` (${assistant})` : ""}</> : <>no run</>;

function Join({ source }: { source: ProvenanceJoinSource }) {
  const l = joinLabel(source);
  return <span className={`prov-join prov-join--${l.kind}`} data-source={source}>{l.text}</span>;
}

function Continues({ c }: { c: ProvenanceContinuation | null }) {
  if (!c) return <>Nothing (fresh start)</>;
  const refs = [c.checkpointId && `checkpoint ${c.checkpointId}`, c.handoffId && `handoff ${c.handoffId}`, c.envelopeId && `envelope ${c.envelopeId}`].filter(Boolean);
  return <>{runRef(c.runId, c.assistantId)} <Join source={c.source} />{refs.length ? <span className="fine-print"> · {refs.join(" · ")}</span> : null}</>;
}

function RunItem({ r }: { r: RunProvenance }) {
  const d = r.routingDecision;
  return (
    <li className="prov-run" aria-label={`Run ${r.runId}`}>
      <div><span className="mono">{r.runId}</span> · {r.assistantId} · {r.executionPath === "harness"
        ? <>Harness (request <span className="mono">{or(r.executionRequestId)}</span>, attempt {or(r.attempt)})</>
        : "Legacy (no execution request)"}</div>
      <dl className="identity-grid">
        <div><dt>Started</dt><dd>{time(r.startedAt)}</dd></div>
        <div><dt>Ended</dt><dd>{r.endedAt ? time(r.endedAt) : "Not ended"}</dd></div>
        <div><dt>Launch</dt><dd>{launchText(r)}</dd></div>
        <div><dt>Prompt</dt><dd>{or(r.promptSource, "not recorded")}{r.compositionRevisionId ? <> · composition <span className="mono">{r.compositionRevisionId}</span></> : null}</dd></div>
        <div><dt>Routing</dt><dd>{d.id === null
          ? <><Join source={d.source} /> no decision names this run</>
          : <>Decision #{d.id} chose {or(d.chosenAssistantId)}{d.at ? <> at {time(d.at)}</> : null} <Join source={d.source} /></>}</dd></div>
        <div><dt>Continues</dt><dd><Continues c={r.continuedFrom} /></dd></div>
        <div><dt>Settled by</dt><dd>{or(r.settlementOwner)}</dd></div>
      </dl>
    </li>
  );
}

function HandoffItem({ h }: { h: HandoffProvenance }) {
  const e = h.envelope;
  return (
    <li className="prov-handoff" aria-label={`Handoff ${h.id}`}>
      <div>
        <span className="mono">{h.id}</span> · {h.record === "envelope_only" ? "Harness envelope with no handoff record" : `trigger ${or(h.trigger)}`} · {time(h.at)} · {h.closed
          ? "closed"
          : <strong className="prov-open">OPEN: no successor has started</strong>}
      </div>
      <div>From {runRef(h.from.runId, h.from.assistantId)} <Join source={h.from.source} /> → to {runRef(h.to.runId, h.to.assistantId)}</div>
      <div className="fine-print">
        checkpoint {or(h.checkpointId)} · {e ? `envelope ${e.id} (${e.state}${e.claimedByRequestId ? `, claimed by request ${e.claimedByRequestId}` : ", unclaimed"})` : "no envelope"}
        {h.successorRoutingDecisionId !== null ? ` · successor decision #${h.successorRoutingDecisionId}` : ""}
      </div>
    </li>
  );
}

function LinkItem({ link }: { link: TaskLink }) {
  return (
    <li className="prov-link" aria-label={`${link.repo}#${link.number}`}>
      <div>
        {link.kind === "pull_request" ? "PR" : "Issue"}{" "}
        <a href={link.url} target="_blank" rel="noreferrer noopener">{link.repo}#{link.number}</a>
      </div>
      <ul className="fine-print">{link.evidence.map((e, i) => <li key={i}>{evidenceText(e)}</li>)}</ul>
    </li>
  );
}

export function ProvenanceView({ p, links, linksError }: { p: Provenance; links: TaskLinks | null; linksError: boolean }) {
  const used = sourcesUsed(p);
  const owner = p.owner.kind === "autopilot"
    ? `Autopilot attempt ${p.owner.attemptId} (item ${p.owner.itemId}, attempt ${p.owner.attemptNo}, ${p.owner.state})`
    : "Operator";
  return (
    <>
      <section aria-label="Provenance owner">
        <h3>Where this task came from</h3>
        <dl className="identity-grid">
          <div><dt>Owner</dt><dd>{owner}</dd></div>
          <div><dt>Run as</dt><dd>{or(p.owner.runAs)}</dd></div>
          <div><dt>Mode</dt><dd>{p.mode}</dd></div>
        </dl>
      </section>
      <section aria-label="Run provenance">
        <h3>Runs ({p.runs.length})</h3>
        {p.runs.length === 0 ? <p className="fine-print">No runs: the task has not started.</p>
          : <ol className="prov-list">{p.runs.map((r) => <RunItem key={r.runId} r={r} />)}</ol>}
      </section>
      <section aria-label="Handoff provenance">
        <h3>Handoffs ({p.handoffs.length})</h3>
        {p.handoffs.length === 0 ? <p className="fine-print">No handoffs.</p>
          : <ul className="prov-list">{p.handoffs.map((h) => <HandoffItem key={h.id} h={h} />)}</ul>}
      </section>
      <section aria-label="Linked issues and PRs">
        <h3>Linked issues and PRs</h3>
        {linksError ? <p role="status" className="error">Links unavailable in this read (the plane may predate API 2.13).</p>
          : !links ? <p className="fine-print">Loading…</p>
          : links.links.length === 0 ? <p className="fine-print">No issue or PR is linked to this task.</p>
          : <ul className="prov-list">{links.links.map((l) => <LinkItem key={`${l.repo}#${l.number}`} link={l} />)}</ul>}
      </section>
      {(used.has("inferred") || used.has("unrecorded")) && (
        <section aria-label="How joins are labelled">
          {used.has("inferred") && (
            <>
              <p className="fine-print"><Join source="inferred" /> joins have no stored key; the plane followed these rules:</p>
              <dl className="identity-grid">
                {Object.entries(p.inferenceRules).map(([name, rule]) => <div key={name}><dt>{ruleName(name)}</dt><dd>{rule}</dd></div>)}
              </dl>
            </>
          )}
          {used.has("unrecorded") && <p className="fine-print"><Join source="unrecorded" /> joins: no record names them, and the plane does not guess.</p>}
        </section>
      )}
    </>
  );
}

export function TaskProvenance({ taskId, refreshKey }: { taskId: string; refreshKey: string }) {
  const [provenance, setProvenance] = useState<Provenance | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [links, setLinks] = useState<TaskLinks | null>(null);
  const [linksError, setLinksError] = useState(false);
  useEffect(() => {
    let live = true;
    void Promise.allSettled([api.provenance(taskId), api.taskLinks(taskId)]).then(([p, l]) => {
      if (!live) return;
      if (p.status === "fulfilled") {
        const why = provenanceProblem(p.value, taskId);
        setProvenance(why ? null : p.value);
        setProblem(why ? `The plane's provenance is not the API 2.12 shape, so nothing is shown: ${why}` : null);
      } else {
        setProvenance(null);
        setProblem("Provenance unavailable in this read (the plane may predate API 2.12).");
      }
      setLinks(l.status === "fulfilled" ? l.value : null);
      setLinksError(l.status === "rejected");
    });
    return () => { live = false; };
  }, [taskId, refreshKey]);
  return (
    <section className="task-provenance" aria-label="Task provenance">
      {problem && <p role="status" className="error">{problem}</p>}
      {provenance ? <ProvenanceView p={provenance} links={links} linksError={linksError} /> : !problem && <p className="fine-print">Loading…</p>}
    </section>
  );
}
