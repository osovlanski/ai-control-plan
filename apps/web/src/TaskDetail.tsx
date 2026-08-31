import { useEffect, useRef, useState } from "react";
import {
  api,
  type Comparison,
  type RoutingExplanation,
  type SessionDetail,
  type SessionSummary,
  type TaskDetail as Detail,
  type TaskEvent,
} from "./api.js";
import { Button, Card, StateBadge, tokens } from "./ui.jsx";

type Tab = "activity" | "usage" | "routing" | "progress" | "handoff" | "compare" | "sessions";

interface PendingApproval {
  requestId: string;
  summary: string;
}

interface Notice {
  level: "info" | "warn";
  text: string;
  at: string;
}

export function TaskDetail({ taskId, onBack }: { taskId: string; onBack: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [state, setState] = useState<string>("");
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const [routing, setRouting] = useState<Array<{ chosen: string | null; at: string; explanation: RoutingExplanation }>>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [handoffs, setHandoffs] = useState<
    Array<{ id: string; trigger: string; at: string; from_assistant: string | null; to_assistant: string | null }>
  >([]);
  const [checkpoints, setCheckpoints] = useState<
    Array<{ id: string; reason: string; at: string; gitRef: string | null }>
  >([]);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("activity");
  const timelineRef = useRef<HTMLDivElement>(null);

  const refresh = () => {
    void api.task(taskId).then((d) => {
      setDetail(d);
      setState(d.state);
    });
    void api.routing(taskId).then(setRouting);
    void api.handoffs(taskId).then(setHandoffs);
    void api.checkpoints(taskId).then(setCheckpoints);
    void api.comparison(taskId).then(setComparison).catch(() => setComparison(null));
    void api.sessions(taskId).then(setSessions).catch(() => setSessions([]));
  };

  const openSession = (id: string) => {
    setSession(null);
    void api.session(id).then(setSession).catch(() => setSession(null));
  };

  useEffect(() => {
    // A new task: drop anything shown for the previous one before refetching.
    setSession(null);
    setSessions([]);
    void api.events(taskId).then(setEvents);
    refresh();

    // Live tail: SSE carries normalized events and authoritative state changes.
    const source = new EventSource(`/api/tasks/${taskId}/events/stream`);
    source.onmessage = (msg) => {
      const payload = JSON.parse(msg.data) as {
        kind: "event" | "state" | "notice";
        event?: TaskEvent;
        state?: { state: string };
        notice?: { level: "info" | "warn"; text: string };
      };
      if (payload.kind === "state" && payload.state) {
        setState(payload.state.state);
        refresh();
      }
      if (payload.kind === "notice" && payload.notice) {
        // Automatic failover is never silent — it lands here as a banner.
        setNotices((prev) => [...prev, { ...payload.notice!, at: new Date().toISOString() }]);
      }
      if (payload.kind === "event" && payload.event) {
        const event = payload.event;
        setEvents((prev) => [...prev, event]);
        if (event.type === "approval.requested") {
          setApproval({
            requestId: (event.payload as { requestId: string }).requestId,
            summary: event.summary,
          });
        }
      }
    };
    return () => source.close();
  }, [taskId]);

  useEffect(() => {
    timelineRef.current?.scrollTo({ top: timelineRef.current.scrollHeight });
  }, [events.length]);

  const respond = async (approved: boolean) => {
    if (!approval) return;
    await api.approve(taskId, approval.requestId, approved);
    setApproval(null);
  };

  if (!detail) return <p style={{ color: tokens.muted }}>Loading…</p>;

  const usage = detail.runs.at(-1)?.usage as
    | { inputTokens?: number; outputTokens?: number; costUsd?: number }
    | null
    | undefined;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.8rem", marginBottom: "1rem" }}>
        <Button variant="secondary" onClick={onBack}>
          ← Board
        </Button>
        <h2 style={{ margin: 0, fontSize: "1.05rem" }}>{detail.id}</h2>
        <StateBadge state={state} />
        <span style={{ marginLeft: "auto", display: "flex", gap: "0.4rem" }}>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void api
                .checkpoint(taskId)
                .then(refresh)
                .finally(() => setBusy(false));
            }}
          >
            Checkpoint
          </Button>
          <Button
            variant="secondary"
            disabled={busy || ["COMPLETED", "FAILED", "CANCELLED"].includes(state)}
            onClick={() => {
              setBusy(true);
              void api
                .handoff(taskId)
                .then(refresh)
                .catch((e: Error) =>
                  setNotices((p) => [...p, { level: "warn", text: e.message, at: new Date().toISOString() }]),
                )
                .finally(() => setBusy(false));
            }}
          >
            Hand off
          </Button>
          {detail.active && (
            <Button variant="danger" onClick={() => void api.cancel(taskId).then(refresh)}>
              Cancel
            </Button>
          )}
        </span>
      </div>
      <p style={{ marginTop: 0, color: tokens.muted }}>{detail.goal}</p>

      {notices.map((n, i) => (
        <Card
          key={i}
          style={{
            borderColor: n.level === "warn" ? tokens.warn : tokens.accent,
            background: `${n.level === "warn" ? tokens.warn : tokens.accent}0d`,
            marginBottom: "0.6rem",
            padding: "0.65rem 0.9rem",
          }}
        >
          <span style={{ fontSize: "0.88rem" }}>
            <strong>{n.level === "warn" ? "Failover" : "Handoff"}</strong> · {n.text}
          </span>
        </Card>
      ))}

      {approval && (
        <Card style={{ borderColor: tokens.warn, background: `${tokens.warn}0d`, marginBottom: "1rem" }}>
          <strong style={{ fontSize: "0.9rem" }}>Approval requested</strong>
          <p style={{ margin: "0.4rem 0 0.7rem", fontSize: "0.9rem" }}>{approval.summary}</p>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <Button onClick={() => void respond(true)}>Approve</Button>
            <Button variant="danger" onClick={() => void respond(false)}>
              Deny
            </Button>
          </div>
        </Card>
      )}

      <div style={{ display: "flex", gap: "0.4rem", marginBottom: "0.9rem" }}>
        {(["activity", "usage", "routing", "progress", "handoff", "compare", "sessions"] as Tab[]).map((t) => (
          <Button key={t} variant={tab === t ? "primary" : "secondary"} onClick={() => setTab(t)}>
            {t[0]!.toUpperCase() + t.slice(1)}
          </Button>
        ))}
      </div>

      {tab === "activity" && (
        <Card>
          <div ref={timelineRef} style={{ maxHeight: 460, overflowY: "auto" }}>
            {events.length === 0 && <p style={{ color: tokens.muted, fontSize: "0.9rem" }}>No events yet.</p>}
            {events.map((e) => (
              <div
                key={`${e.run_id}-${e.seq}`}
                style={{
                  display: "grid",
                  gridTemplateColumns: "62px 130px 1fr",
                  gap: "0.75rem",
                  padding: "0.3rem 0",
                  borderBottom: `1px solid ${tokens.border}`,
                  fontSize: "0.85rem",
                }}
              >
                <span style={{ color: tokens.muted, fontFamily: tokens.mono }}>
                  {new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                </span>
                <span style={{ fontFamily: tokens.mono, color: eventColor(e.type) }}>{e.type}</span>
                <span>
                  {e.summary}
                  {e.phase && <em style={{ color: tokens.muted }}> · {e.phase}</em>}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {tab === "usage" && (
        <Card>
          <h3 style={{ marginTop: 0, fontSize: "0.95rem" }}>Runs</h3>
          {detail.runs.map((r) => (
            <div key={r.id} style={{ fontSize: "0.88rem", marginBottom: "0.6rem" }}>
              <strong>{r.assistant_id}</strong> · {r.state} · started{" "}
              {new Date(r.started_at).toLocaleTimeString()}
              {r.usage && (
                <div style={{ color: tokens.muted }}>
                  tokens in/out: {String((r.usage as Record<string, unknown>).inputTokens ?? "?")}/
                  {String((r.usage as Record<string, unknown>).outputTokens ?? "?")}
                </div>
              )}
            </div>
          ))}
          {usage?.costUsd !== undefined && (
            <p style={{ fontSize: "0.85rem", color: tokens.muted }}>
              Estimated cost: ${usage.costUsd.toFixed(4)}
            </p>
          )}
        </Card>
      )}

      {tab === "routing" && (
        <Card>
          {routing.map((r, i) => (
            <div key={i} style={{ marginBottom: "0.9rem", fontSize: "0.88rem" }}>
              <div style={{ color: tokens.muted }}>{new Date(r.at).toLocaleString()}</div>
              <div>
                chose <strong>{r.chosen ?? "nothing"}</strong> —{" "}
                <code style={{ fontFamily: tokens.mono }}>{r.explanation.ruleFired}</code>
              </div>
              {r.explanation.candidates
                .filter((c) => c.filterFailures.length > 0)
                .map((c) => (
                  <div key={c.assistantId} style={{ color: tokens.muted, fontSize: "0.82rem" }}>
                    {c.assistantId}: {c.filterFailures.join(", ")}
                  </div>
                ))}
            </div>
          ))}
        </Card>
      )}

      {tab === "progress" && (
        <Card>
          <Section title="Constraints (user-imposed)" items={detail.envelope.constraints} />
          <Section title="Completed" items={detail.envelope.completed} />
          <Section title="Remaining" items={detail.envelope.remaining} />
          <Section title="Changed files" items={detail.envelope.artifacts.changedFiles} />
          <h4 style={{ fontSize: "0.85rem", marginBottom: "0.3rem" }}>Decisions</h4>
          {detail.envelope.decisions.length === 0 && (
            <p style={{ color: tokens.muted, fontSize: "0.85rem" }}>None recorded.</p>
          )}
          {detail.envelope.decisions.map((d, i) => (
            <div key={i} style={{ fontSize: "0.85rem" }}>
              {d.text} <span style={{ color: tokens.muted }}>({d.madeBy})</span>
            </div>
          ))}
          <p style={{ marginTop: "1rem", fontSize: "0.82rem", color: tokens.muted }}>
            <a href={`/api/tasks/${taskId}/files/progress.md`} target="_blank" rel="noreferrer">
              View rendered progress.md →
            </a>
          </p>
        </Card>
      )}

      {tab === "compare" && (
        <Card>
          {!comparison || comparison.competitors.length < 2 ? (
            <p style={{ color: tokens.muted, fontSize: "0.9rem", margin: 0 }}>
              This task ran on a single assistant. Start a task in Compare mode to see competitors side by side.
            </p>
          ) : (
            <>
              <p style={{ marginTop: 0, fontSize: "0.85rem", color: tokens.muted }}>
                {comparison.decided
                  ? `Decided by ${comparison.decided.decidedBy}${comparison.decided.mergedRef ? ` · merged ${comparison.decided.mergedRef.slice(0, 8)}` : ""}`
                  : "Both finished — pick the result to keep. The rejected branch stays inspectable."}
              </p>
              <div style={{ display: "grid", gridTemplateColumns: `repeat(${comparison.competitors.length}, minmax(0, 1fr))`, gap: "0.8rem" }}>
                {comparison.competitors.map((c) => (
                  <div
                    key={c.runId}
                    style={{
                      border: `1px solid ${c.outcome === "winner" ? tokens.ok : tokens.border}`,
                      background: c.outcome === "winner" ? `${tokens.ok}0d` : "transparent",
                      borderRadius: 8,
                      padding: "0.75rem",
                      opacity: c.outcome === "rejected" ? 0.6 : 1,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                      <strong style={{ fontSize: "0.9rem" }}>{c.assistantId}</strong>
                      {c.outcome && (
                        <span style={{ fontSize: "0.72rem", fontWeight: 600, color: c.outcome === "winner" ? tokens.ok : tokens.muted }}>
                          {c.outcome.toUpperCase()}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: "0.8rem", color: tokens.muted, marginTop: "0.35rem" }}>
                      {c.durationMs !== null && <>⏱ {(c.durationMs / 1000).toFixed(1)}s</>}
                      {c.tests && <> · ✓{c.tests.passed ?? 0}/✗{c.tests.failed ?? 0}</>}
                      {c.usage?.outputTokens !== undefined && <> · {(c.usage.inputTokens ?? 0) + c.usage.outputTokens} tok</>}
                    </div>
                    {c.diff && (
                      <div style={{ fontSize: "0.8rem", marginTop: "0.35rem" }}>
                        <span style={{ color: tokens.ok }}>+{c.diff.insertions}</span>{" "}
                        <span style={{ color: tokens.danger }}>−{c.diff.deletions}</span>{" "}
                        <span style={{ color: tokens.muted }}>across {c.diff.changedFiles.length} file(s)</span>
                      </div>
                    )}
                    {c.branch && (
                      <code style={{ fontFamily: tokens.mono, fontSize: "0.72rem", color: tokens.muted }}>{c.branch}</code>
                    )}
                    {!comparison.decided && state === "WAITING_INPUT" && (
                      <div style={{ marginTop: "0.6rem" }}>
                        <Button
                          disabled={busy}
                          onClick={() => {
                            setBusy(true);
                            void api
                              .resolveComparison(taskId, c.runId)
                              .then(refresh)
                              .finally(() => setBusy(false));
                          }}
                        >
                          Keep this
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>
      )}

      {tab === "handoff" && (
        <Card>
          <h3 style={{ marginTop: 0, fontSize: "0.95rem" }}>Handoffs</h3>
          {handoffs.length === 0 && (
            <p style={{ color: tokens.muted, fontSize: "0.85rem" }}>
              This task has stayed with one assistant.
            </p>
          )}
          {handoffs.map((h) => (
            <div key={h.id} style={{ fontSize: "0.88rem", marginBottom: "0.5rem" }}>
              <span
                style={{
                  fontFamily: tokens.mono,
                  fontSize: "0.78rem",
                  color: h.trigger === "manual" ? tokens.accent : tokens.warn,
                }}
              >
                {h.trigger}
              </span>{" "}
              {h.from_assistant ?? "—"} → <strong>{h.to_assistant ?? "(pending)"}</strong>
              <span style={{ color: tokens.muted }}> · {new Date(h.at).toLocaleString()}</span>
            </div>
          ))}

          <h3 style={{ fontSize: "0.95rem", marginTop: "1.2rem" }}>Checkpoints</h3>
          {checkpoints.length === 0 && (
            <p style={{ color: tokens.muted, fontSize: "0.85rem" }}>No checkpoints yet.</p>
          )}
          {checkpoints.map((c) => (
            <div key={c.id} style={{ fontSize: "0.85rem" }}>
              <span style={{ fontFamily: tokens.mono, fontSize: "0.78rem", color: tokens.muted }}>
                {c.reason}
              </span>{" "}
              {new Date(c.at).toLocaleString()}
              {c.gitRef && (
                <code style={{ fontFamily: tokens.mono, color: tokens.muted }}> · {c.gitRef.slice(0, 8)}</code>
              )}
            </div>
          ))}

          {checkpoints.length > 0 && (
            <p style={{ marginTop: "1rem", fontSize: "0.82rem", color: tokens.muted }}>
              <a href={`/api/tasks/${taskId}/files/handoff.md`} target="_blank" rel="noreferrer">
                View the handoff package the next assistant would receive →
              </a>
            </p>
          )}
        </Card>
      )}

      {tab === "sessions" && (
        <Card>
          <h3 style={{ marginTop: 0, fontSize: "0.95rem" }}>Execution Harness sessions</h3>
          {sessions.length === 0 && (
            <p style={{ color: tokens.muted, fontSize: "0.85rem" }}>
              No Harness sessions recorded for this task yet.
            </p>
          )}
          {sessions.map((s) => (
            <div key={s.sessionId} style={{ fontSize: "0.86rem", marginBottom: "0.4rem" }}>
              <button
                onClick={() => openSession(s.sessionId)}
                style={{
                  fontFamily: tokens.mono,
                  fontSize: "0.78rem",
                  background: "none",
                  border: "none",
                  color: tokens.accent,
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                {s.sessionId}
              </button>{" "}
              <strong>{s.sessionState}</strong>
              <span style={{ color: tokens.muted }}> ({s.state}) · attempt {s.attempt}</span>
              {s.cancelRequested && <span style={{ color: tokens.warn }}> · cancel requested</span>}
            </div>
          ))}

          {session && (
            <div style={{ marginTop: "1rem", borderTop: `1px solid ${tokens.muted}33`, paddingTop: "0.8rem" }}>
              <h4 style={{ fontSize: "0.88rem", margin: "0 0 0.4rem" }}>
                {session.sessionId} — {session.sessionState}
                <span style={{ color: tokens.muted, fontWeight: 400 }}> / legacy {session.state}</span>
              </h4>
              {session.correlation?.parentTaskId && (
                <p style={{ fontSize: "0.82rem", margin: "0 0 0.4rem", color: tokens.muted }}>
                  parent {session.correlation.parentTaskId}
                  {session.correlation.groupId && ` · group ${session.correlation.groupId}`}
                </p>
              )}
              {session.result && (
                <p style={{ fontSize: "0.84rem", margin: "0 0 0.4rem" }}>
                  outcome <strong>{session.result.outcome}</strong>
                  {session.result.enforcement && (
                    <>
                      {" · "}enforcement: tools {session.result.enforcement.tools}, budget{" "}
                      {session.result.enforcement.budget}, isolation {session.result.enforcement.isolation}
                    </>
                  )}
                  {session.result.verification && (
                    <>
                      {" · "}verification{" "}
                      <strong>{session.result.verification.passed ? "passed" : "failed"}</strong>
                    </>
                  )}
                </p>
              )}
              {session.audit.length > 0 && (
                <ul style={{ margin: "0.3rem 0 0", paddingLeft: "1.1rem", fontSize: "0.82rem" }}>
                  {session.audit.map((e) => (
                    <li key={e.seq}>
                      <span style={{ fontFamily: tokens.mono, color: tokens.muted }}>{e.type}</span> {e.summary}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

function Section({ title, items }: { title: string; items: string[] }) {
  return (
    <div style={{ marginBottom: "0.9rem" }}>
      <h4 style={{ fontSize: "0.85rem", margin: "0 0 0.3rem" }}>{title}</h4>
      {items.length === 0 ? (
        <p style={{ color: tokens.muted, fontSize: "0.85rem", margin: 0 }}>—</p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.85rem" }}>
          {items.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function eventColor(type: string): string {
  if (type.startsWith("limit.")) return tokens.warn;
  if (type === "error" || type === "tool.failed") return tokens.danger;
  if (type === "approval.requested") return tokens.warn;
  if (type === "run.ended") return tokens.ok;
  return tokens.muted;
}
