import type { ReactNode } from "react";
import type { SessionDetail, SessionVerification, TaskContext, TaskDetail } from "../api.js";
import { clock } from "./model.js";
import type { TabRead } from "./reads.js";
import { TABS, contextView, filesView, verifyView, type TabId } from "./tabs.js";

export interface VerifyData { session: SessionDetail | undefined; verification: SessionVerification | null }
export interface FilesData { checkpoints: Array<{ id: string; reason: string; at: string; gitRef: string | null }>; session: SessionDetail | undefined }

/** The accessible name of the detail region for a tab, so a test or a screen reader can tell them apart. */
export const TAB_REGION: Record<TabId, string> = { log: "Event log", verify: "Verification", files: "Files", ctx: "Context" };

const dim = (on: boolean) => (on ? "sv-muted" : undefined);

/** A tab's read, shown as text while it has no value. Null once there is a value to render. */
function Waiting<T>({ read, what }: { read: TabRead<T>; what: string }) {
  if (read.status === "loading" || read.status === "idle") return <p className="sv-muted">reading {what}…</p>;
  if (read.status === "error") return <p className="sv-error">{what} read failed: {read.message}</p>;
  return null;
}

function VerifyPanel({ read, hasRun }: { read: TabRead<VerifyData>; hasRun: boolean | null }) {
  if (hasRun === false) return <p className="sv-muted">no run yet: nothing to verify</p>;
  if (read.status !== "ok") return <Waiting read={read} what="verification" />;
  const v = verifyView(read.value.session, read.value.verification);
  return <>
    {v.verdict && <p>verification <b>{v.verdict}</b></p>}
    {v.plan && <p className="sv-muted">{v.plan}</p>}
    {!!v.checks.length && <ul className="sv-checks" aria-label="Verification checks">
      {v.checks.map(c => <li key={c.key} data-status={c.label}>
        <b className={`sv-check-${c.label}`}>{c.label}</b> {c.name}{!c.required && <span className="sv-muted"> · not required</span>}
        {c.summary && <div className="sv-check-summary">{c.summary}</div>}
      </li>)}
    </ul>}
    {v.note && <p className="sv-muted">{v.note}</p>}
  </>;
}

function FilesPanel({ detail, read }: { detail: TaskDetail | undefined; read: TabRead<FilesData> }) {
  if (read.status !== "ok") return <Waiting read={read} what="checkpoints" />;
  const f = filesView(detail, read.value.checkpoints, read.value.session);
  return <>
    <p>branch <b className={dim(!f.branch)}>{f.branch ?? "—"}</b></p>
    <p>changed files <span className="sv-muted">({f.files.length})</span></p>
    {f.files.length ? <ul className="sv-files" aria-label="Changed files">{f.files.map(file => <li key={file}>{file}</li>)}</ul> : <p className="sv-muted">none recorded</p>}
    <p>checkpoints <span className="sv-muted">({f.checkpoints.length})</span></p>
    {f.checkpoints.length ? <ul className="sv-files" aria-label="Checkpoints">{f.checkpoints.map(c => <li key={c.id}>
      <time>{clock(new Date(c.at), true)}</time> <b>{c.id}</b> {c.reason}{" "}
      <span className="sv-muted">git {c.gitRef ?? "—"} · diff {c.diffStat?.trim() || "—"}</span>
    </li>)}</ul> : <p className="sv-muted">none recorded</p>}
  </>;
}

/** `undefined` = not read yet, `null` = the read failed. */
function ContextPanel({ context }: { context: TaskContext | null | undefined }) {
  if (context === undefined) return <p className="sv-muted">reading context…</p>;
  const v = contextView(context);
  return <>
    {v.note && <p className="sv-muted">{v.note}</p>}
    {!!v.rows.length && <dl className="sv-kv" aria-label="Context observation">
      {v.rows.map(r => <div key={r.label}><dt>{r.label}</dt><dd className={dim(r.dim)}>{r.value}</dd></div>)}
    </dl>}
    {!!v.breakdown.length && <>
      <p>breakdown</p>
      <ul className="sv-files" aria-label="Context breakdown">{v.breakdown.map(b => <li key={b.category}>{b.category} <span className="sv-muted">{b.tokens}</span></li>)}</ul>
    </>}
  </>;
}

/**
 * The detail pane as four tabs on the selected task: log | verify | files | ctx. The number keys are
 * handled by ShellView (one key handler for the whole shell); the buttons here are for the pointer.
 * Nothing in a tab writes. The log panel is the part A event log, passed in as `log`.
 */
export function DetailTabs({ tab, onTab, pid, detail, hasRun, context, verify, files, before, log }: {
  tab: TabId;
  onTab: (tab: TabId) => void;
  pid: string | null;
  detail: TaskDetail | undefined;
  /** Whether the task has any run; null until the task read lands. */
  hasRun: boolean | null;
  context: TaskContext | null | undefined;
  verify: TabRead<VerifyData>;
  files: TabRead<FilesData>;
  /** Shown on every tab between the tab bar and the panel: the phone-width row meta and the focused approval. */
  before: ReactNode;
  log: ReactNode;
}) {
  return <>
    <div className="sv-tabs" role="tablist" aria-label="Detail tabs">
      {TABS.map(t => <button key={t.id} type="button" role="tab" id={`sv-tab-${t.id}`} aria-selected={t.id === tab} aria-controls="sv-tabpanel"
        tabIndex={t.id === tab ? 0 : -1} className="sv-tab" onClick={() => onTab(t.id)}>
        <kbd>{t.key}</kbd> {t.label}
      </button>)}
      <span className="sv-detail-head sv-tabs-id"><b>{pid ?? "—"}</b> <span className="sv-muted">· Enter opens the Inspector</span></span>
    </div>
    {before}
    <div id="sv-tabpanel" role="tabpanel" aria-labelledby={`sv-tab-${tab}`} className="sv-panel">
      {!pid ? <p className="sv-muted">no task selected</p>
        : tab === "log" ? log
        : tab === "verify" ? <VerifyPanel read={verify} hasRun={hasRun} />
        : tab === "files" ? <FilesPanel detail={detail} read={files} />
        : <ContextPanel context={context} />}
    </div>
  </>;
}
