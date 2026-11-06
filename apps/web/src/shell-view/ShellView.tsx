import { Restart, useRestartOffered } from "../Restart.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, type CompositionPreview, type SessionSummary } from "../api.js";
import { DecisionView } from "../Composition.js";
import { readRepository, writeRepository } from "./repository.js";
import { composeFor } from "../NewTask.js";
import { useBoard } from "../board/useBoard.js";
import { Inspector } from "../board/Inspector.js";
import { useMissionSnapshot } from "../board/useMissionSnapshot.js";
import {
  COLUMNS, KEYMAP, assistantStatus, clock, isTypingTarget, logLines, quotaFill, quotaPercent, sortRows, toRow,
  type ProcessRow, type Sort, type SortKey,
} from "./model.js";
import { readSession, readVerification, usePendingApprovals, useProcessDetails, useTabRead } from "./reads.js";
import { DetailTabs, TAB_REGION, type FilesData, type VerifyData } from "./DetailTabs.js";
import { TABS, lastRunId, type TabId } from "./tabs.js";

/** What Tab showed for the current command line. Enter runs exactly this. */
const NO_SESSIONS: SessionSummary[] = [];
interface Preview { repoPath: string; composed: Awaited<ReturnType<typeof composeFor>>; goal: string; taskId: string; chosen: string | null; rule: string; composition: string; digest: string | null }
type Confirm = { kind: "deny"; taskId: string; requestId: string } | { kind: "cancel"; taskId: string };

const dim = (v: string) => v === "unknown" || v === "—" ? "sv-muted" : "";

/** The wide-only columns for the selected row, shown in the detail pane header at phone width. */
const rowMeta = (r: ProcessRow): Array<[string, string]> => [
  ["stage", r.stage], ["phase", r.phase], ["assist", r.assistant], ["model", r.model], ["cost", r.cost], ["ctx", r.ctx], ["checks", r.checks], ["age", r.age],
];

const compositionLine = (c: Awaited<ReturnType<typeof composeFor>>): [string, string | null] => {
  if (c.state === "off") return ["composer off", null];
  if (c.state === "error") return [`compose unavailable: ${c.message}`, null];
  if (c.state !== "ready") return ["", null];
  const o = c.preview.outcome;
  if (o.status !== "composed") return [`compose ${o.status}: ${o.reason}`, null];
  return [`composed ${c.preview.compositionDigest?.slice(0, 19) ?? ""}…`, c.preview.compositionDigest];
};

/**
 * The Overview as a shell: top panel, process list, the selected task's event log and a command
 * line, keyboard first. Every key maps to a command the web already sends; nothing here is new API.
 */
export function ShellView({ active, workspace, repositories, onOpen }: { active: boolean; workspace: string | null; repositories: string[]; onOpen: (id: string) => void }) {
  const [repository, setRepository] = useState(readRepository);
  const repoPath = repositories.includes(repository) ? repository : "";
  const repoName = repoPath ? repoPath.split(/[\\/]/).filter(Boolean).at(-1) ?? repoPath : null;
  const [revision, setRevision] = useState(0);
  const { tasks, assistants, cooldowns, error, loading, unavailable } = useBoard(revision, active);
  const details = useProcessDetails(tasks, active);
  const [now, setNow] = useState(() => Date.now());
  const [sort, setSort] = useState<Sort>({ key: null, dir: 1 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [detailTab, setDetailTab] = useState<TabId>("log");
  const [help, setHelp] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [status, setStatus] = useState("");
  const [line, setLine] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [actRev, setActRev] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);

  const rows = useMemo(() => sortRows(tasks.map(t => toRow(t, details[t.id], now)), sort), [tasks, details, now, sort]);
  const current = rows.find(r => r.pid === selectedId) ?? rows[0];
  const needYou = rows.filter(r => r.state === "NEEDS-YOU").length;
  const { snapshot, error: snapshotError } = useMissionSnapshot(active ? current?.pid ?? null : null, actRev, true);
  const { pending, error: approvalError, loading: approvalLoading } = usePendingApprovals(current?.pid ?? null, active && ["AWAITING_APPROVAL", "WAITING_INPUT"].includes(current?.rawState ?? ""), actRev);
  const restartOffered = useRestartOffered(snapshotError ? null : snapshot?.detail.id ?? null, snapshot?.detail.state ?? "", snapshot?.sessions ?? NO_SESSIONS);
  const focused = pending[0];
  // The verify and files tabs read only while they are the visible tab, every 4 s while the task is live.
  const runId = lastRunId(snapshot?.detail);
  const live = !!snapshot && !["COMPLETED", "FAILED", "CANCELLED"].includes(snapshot.detail.state);
  const showing = (id: TabId) => active && !inspecting && detailTab === id && !!current;
  const verifyRead = useTabRead<VerifyData>(showing("verify") && runId ? `verify:${runId}` : null,
    async () => {
      const [session, verification] = await Promise.all([readSession(runId!), readVerification(runId!)]);
      return { session, verification };
    }, live, actRev);
  const filesRead = useTabRead<FilesData>(showing("files") && current ? `files:${current.pid}:${runId ?? ""}` : null,
    async () => {
      const [checkpoints, session] = await Promise.all([api.checkpoints(current!.pid), runId ? readSession(runId) : Promise.resolve(undefined)]);
      return { checkpoints, session };
    }, live, actRev);
  const lines = snapshot ? logLines(snapshot.events) : [];

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [current?.pid]);
  const logEnd = useRef<HTMLOListElement>(null);
  useEffect(() => { logEnd.current?.lastElementChild?.scrollIntoView?.({ block: "nearest" }); }, [lines.length, current?.pid]);

  const refresh = useCallback(() => { setRevision(r => r + 1); setActRev(r => r + 1); }, []);
  const act = useCallback(async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    setStatus(`${label}…`);
    try {
      await fn();
      setStatus(`${label}: done`);
      refresh();
    } catch (e) {
      setStatus(`${label}: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const move = (delta: number) => {
    if (!rows.length) return;
    const i = Math.max(0, rows.findIndex(r => r.pid === current?.pid));
    setSelectedId(rows[Math.min(rows.length - 1, Math.max(0, i + delta))]!.pid);
    setConfirm(null);
  };

  const approve = () => {
    if (!current) return;
    if (!focused) { setStatus(`${current.pid}: ${approvalLoading ? "reading approval state, try again" : "no approval pending"}`); return; }
    void act(`approve ${focused.requestId}`, () => api.approve(current.pid, focused.requestId, true));
  };
  const askDeny = () => {
    if (!current) return;
    if (!focused) { setStatus(`${current.pid}: ${approvalLoading ? "reading approval state, try again" : "no approval pending"}`); return; }
    setConfirm({ kind: "deny", taskId: current.pid, requestId: focused.requestId });
  };
  const confirmNow = (yes: boolean) => {
    const c = confirm;
    setConfirm(null);
    if (!c) return;
    if (!yes) { setStatus(`${c.kind} not sent`); return; }
    if (c.kind === "deny") void act(`deny ${c.requestId}`, () => api.approve(c.taskId, c.requestId, false));
    else void act(`cancel ${c.taskId}`, () => api.cancel(c.taskId));
  };

  const runPreview = async (goal: string): Promise<Preview> => {
    if (preview?.goal === goal && preview.repoPath === repoPath) return preview;
    const { taskId } = await api.createTask({ goal, repoPath: repoPath || undefined });
    // The composition preview records the routing decision itself, so it is read back rather than routed twice.
    const composed = await composeFor(taskId);
    const recorded = composed.state === "ready" && composed.preview.routingDecisionId !== null
      ? (await api.routing(taskId)).at(-1)?.explanation : undefined;
    const explanation = recorded ?? await api.route(taskId);
    const [composition, digest] = compositionLine(composed);
    const p: Preview = { repoPath, composed, goal, taskId, chosen: explanation.chosen ?? null, rule: explanation.ruleFired, composition, digest };
    setPreview(p);
    setSelectedId(taskId);
    setRevision(r => r + 1);
    return p;
  };

  const tab = async () => {
    const goal = line.trim();
    if (!goal || busy) return;
    setBusy(true);
    try { await runPreview(goal); setStatus(""); } catch (e) { setStatus(`preview: ${(e as Error).message}`); } finally { setBusy(false); }
  };

  const enter = async () => {
    const goal = line.trim();
    if (!goal || busy) return;
    if ((goal === "y" || goal === "n") && focused && current) {
      setLine("");
      if (goal === "y") approve(); else askDeny();
      return;
    }
    setBusy(true);
    let p: Preview | undefined;
    try {
      p = await runPreview(goal);
      if (!p.chosen) { setStatus(`${p.taskId}: no eligible assistant, nothing started`); return; }
      const started = await api.start(p.taskId, undefined, p.digest ?? undefined);
      setStatus(`started ${p.taskId} on ${started.assistantId}`);
      setLine("");
      setPreview(null);
      setSelectedId(p.taskId);
      refresh();
    } catch (e) {
      if (e instanceof ApiError && e.reason === "composition_drift") {
        // Nothing started. Show the plane's new decision; the next Enter runs that one.
        const fresh = (e.body as { preview?: CompositionPreview }).preview;
        if (fresh && p) {
          const [composition, digest] = compositionLine({ state: "ready", preview: fresh });
          setPreview({ ...p, composition, digest, composed: { state: "ready", preview: fresh } });
        }
        setStatus("composition changed since the preview, nothing started. Enter again to run the new one.");
      } else setStatus(`start: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target) || e.defaultPrevented) return;
      if (confirm) {
        if (e.key === "y") confirmNow(true);
        else if (e.key === "n" || e.key === "Escape") confirmNow(false);
        else return;
        e.preventDefault();
        return;
      }
      const keys: Record<string, () => void> = {
        j: () => move(1), ArrowDown: () => move(1),
        k: () => move(-1), ArrowUp: () => move(-1),
        Enter: () => { if (current) setInspecting(true); },
        "/": () => input.current?.focus(),
        a: approve,
        d: askDeny,
        c: () => current && setConfirm({ kind: "cancel", taskId: current.pid }),
        h: () => current && void act(`handoff ${current.pid}`, () => api.handoff(current.pid)),
        r: () => {
          if (!current) return;
          const wait = current.task.wait;
          if (wait?.state !== "active") { setStatus(`${current.pid}: no active wait to run now`); return; }
          void act(`run now ${current.pid}`, () => api.runNow(current.pid, wait.generation));
        },
        "?": () => setHelp(v => !v),
        Escape: () => { if (help) setHelp(false); else if (inspecting) setInspecting(false); else if (detailTab !== "log") setDetailTab("log"); else setStatus(""); },
        // A tab key shows that tab: it leaves the Inspector, which has no tab of its own.
        ...Object.fromEntries(TABS.map(t => [t.key, () => { setDetailTab(t.id); setInspecting(false); }])),
      };
      const fn = keys[e.key];
      // Enter on a focused control (a sort header, a toggle) keeps its own meaning.
      if (!fn || (e.key === "Enter" && e.target instanceof HTMLButtonElement)) return;
      e.preventDefault();
      if (busy && "adhrc".includes(e.key)) return;
      fn();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const sortBy = (key: SortKey) => setSort(s => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : 1 }));
  const confirmText = confirm?.kind === "deny"
    ? `deny ${confirm.requestId} on ${confirm.taskId}? [y/n]`
    : confirm ? `cancel ${confirm.taskId}? [y/n]` : "";

  return <section className="shell-view" aria-label="Shell view">
    <header className="sv-top" aria-label="Top panel">
      <span className="sv-ws">agentic-os · {workspace ?? "…"}</span>
      <label className="sv-repository">Repository <select aria-label="Repository" value={repoPath} disabled={busy} onChange={e => {
        setRepository(e.target.value); writeRepository(e.target.value); setPreview(null);
      }}>
        <option value="">No repository</option>
        {repositories.map(path => <option key={path} value={path}>{path}</option>)}
      </select></label>
      <ul className="sv-quota" aria-label="Assistants">
        {assistants.map(a => {
          const pct = quotaPercent(a);
          const state = assistantStatus(a, cooldowns, now);
          return <li key={a.id} title={pct === null ? "The provider reports no quota windows" : "Highest reported quota window"}>
            <b>{a.id}</b>{" "}
            {pct === null ? <span className="sv-muted">unknown</span> : <>
              <span className="sv-bar" role="meter" aria-label={`${a.id} quota used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={quotaFill(pct)}>
                <span className="sv-bar-fill" style={{ width: `${quotaFill(pct)}%` }} />
              </span>
              <span> {Math.round(pct)}%</span>
            </>}
            {state !== "ready" && <span className="sv-flag"> {state}</span>}
          </li>;
        })}
        {!assistants.length && <li className="sv-muted">{unavailable.includes("Provider discovery") ? "assistants unavailable" : loading ? "reading assistants…" : "no assistants"}</li>}
      </ul>
      <span className={`sv-need ${needYou ? "is-on" : ""}`}>{loading ? "—" : needYou} need you</span>
      <time className="sv-clock" dateTime={new Date(now).toISOString()}>{clock(new Date(now))}</time>
    </header>

    {error && <p role="alert" className="sv-error">task read failed: {error}{tasks.length ? " · showing the last snapshot" : ""}</p>}
    {!!unavailable.length && <p role="status" className="sv-error">unavailable reads: {unavailable.join(", ")}</p>}

    <div className="sv-procs" ref={list} aria-label="Process list" role="region" tabIndex={0}>
      <table>
        <thead><tr>{COLUMNS.map(([key, label, wide]) => <th key={key} className={wide ? "sv-wide" : undefined} aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
          <button type="button" onClick={() => sortBy(key)}>{label}{sort.key === key ? (sort.dir === 1 ? " ↑" : " ↓") : ""}</button>
        </th>)}</tr></thead>
        <tbody>
          {rows.map(r => <tr key={r.pid} aria-selected={r.pid === current?.pid} className={`sv-row st-${r.state.toLowerCase()}`}
            onClick={() => { setSelectedId(r.pid); setConfirm(null); }} onDoubleClick={() => { setSelectedId(r.pid); setInspecting(true); }}>
            <td className="sv-pid">{r.pid}</td>
            <td title={r.rawState}>{r.state}</td>
            <td className={`sv-wide ${dim(r.stage)}`} title={r.stageRule || undefined}>{r.stage}</td>
            <td className={`sv-wide ${dim(r.phase)}`}>{r.phase}</td>
            <td className="sv-wide">{r.assistant}</td>
            <td className={`sv-wide ${dim(r.model)}`}>{r.model}</td>
            <td className={dim(r.tokens)}>{r.tokens}</td>
            <td className={`sv-wide ${dim(r.cost)}`} title={r.cost.startsWith("~") ? "estimated" : r.cost.startsWith("$") ? "measured" : undefined}>{r.cost}</td>
            <td className={`sv-wide ${r.ctxStale ? "sv-stale" : dim(r.ctx)}`} title={r.ctxStale ? "stale observation" : undefined}>{r.ctx}</td>
            <td className={`sv-wide ${dim(r.checks)}`} title={r.checksTitle || undefined}>{r.checks}</td>
            <td className="sv-wide">{r.age}</td>
            {r.cause ? <td className="sv-goal sv-cause" title={r.goal}>{r.cause}</td> : <td className="sv-goal">{r.goal}</td>}
          </tr>)}
        </tbody>
      </table>
      {!rows.length && <p className="sv-muted sv-empty">{loading ? "reading tasks…" : error ? "task list unavailable" : "no tasks. type a goal below and press Enter."}</p>}
    </div>

    <div className="sv-detail" role="region" aria-label={inspecting ? "Inspector" : TAB_REGION[detailTab]}>
      {inspecting && current ? <>
        <p className="sv-detail-head"><b>inspector</b> {current.pid} <span className="sv-muted">· Esc back</span></p>
        <Inspector key={current.pid} task={current.task} onOpen={() => onOpen(current.pid)} />
      </> : <DetailTabs tab={detailTab} onTab={setDetailTab} pid={current?.pid ?? null} detail={snapshot?.detail}
        hasRun={snapshot ? snapshot.detail.runs.length > 0 : null} context={snapshot ? snapshot.context : undefined}
        verify={verifyRead} files={filesRead}
        before={<>
          {current && <p className="sv-meta" aria-label="Selected process">{rowMeta(current).map(([k, v]) => <span key={k}>{k} <b className={k === "ctx" && current.ctxStale ? "sv-stale" : dim(v)}>{v}</b></span>)}</p>}
          {focused && <p className="sv-approval" role="group" aria-label="Focused approval">
            approval.requested {focused.requestId}{pending.length > 1 ? ` (1 of ${pending.length})` : ""} · <kbd>a</kbd> approve <kbd>d</kbd> deny
          </p>}
          {approvalError && <p className="sv-error">approval state unavailable: {approvalError}</p>}
        </>}
        log={!current ? null : snapshotError && !snapshot ? <p className="sv-error">event read failed: {snapshotError}</p>
          : !snapshot ? <p className="sv-muted">reading events…</p>
          : snapshot.unavailable.includes("Events") ? <p className="sv-error">event read unavailable</p>
          : !lines.length ? <p className="sv-muted">no events recorded</p>
          : <ol className="sv-log" ref={logEnd}>{lines.map(l => <li key={l.key}><time>{l.time}</time> <b>{l.type}</b> {l.summary}</li>)}</ol>} />}
    </div>

    <form className="sv-cmd" aria-label="Command line" onSubmit={e => { e.preventDefault(); void enter(); }}>
      <label htmlFor="sv-cmd-input">agentic-os [{repoName ?? "no repo: route only"}]$</label>
      <input id="sv-cmd-input" ref={input} value={line} autoComplete="off" spellCheck={false} readOnly={busy}
        aria-describedby="sv-cmd-help"
        placeholder="describe a goal · Tab previews the route · Enter runs"
        onChange={e => { setLine(e.target.value); if (preview && e.target.value.trim() !== preview.goal) setPreview(null); }}
        onKeyDown={e => {
          if (e.key === "Tab" && !e.shiftKey && line.trim()) { e.preventDefault(); void tab(); }
          if (e.key === "Escape") { e.preventDefault(); input.current?.blur(); list.current?.focus(); }
        }} />
      <span id="sv-cmd-help" className="sv-hint">[Tab] route preview</span>
    </form>
    {preview && <div className="sv-preview-pane"><p className="sv-preview" aria-label="Route preview">
      route → <b>{preview.chosen ?? "no eligible assistant"}</b> · {preview.rule}{preview.composition && ` · ${preview.composition}`} · task {preview.taskId}
    </p>
      {preview.composed.state === "ready" && <section aria-label="Composition preview">
        <DecisionView decision={preview.composed.preview.decision} outcome={preview.composed.preview.outcome}
          spec={preview.composed.preview.specDraft} digest={preview.composed.preview.compositionDigest} resynced={preview.composed.preview.resynced} />
      </section>}
    </div>}
    <div className="sv-status" role="status">{confirmText || status} {restartOffered && current && <Restart key={current.pid} taskId={current.pid} busy={busy} onRestart={() => { void act(`restart ${current.pid}`, () => api.restart(current.pid)); }} />}</div>

    {help && <div className="sv-help" role="dialog" aria-label="Keys">
      <p><b>keys</b> <span className="sv-muted">· Esc closes</span></p>
      <dl>{KEYMAP.map(([k, v]) => <div key={k}><dt><kbd>{k}</kbd></dt><dd>{v}</dd></div>)}</dl>
      <p className="sv-muted">Keys do nothing while the command line has focus, except Esc. In the command line, <kbd>y</kbd> or <kbd>n</kbd> then Enter answers the focused approval.</p>
    </div>}
  </section>;
}
