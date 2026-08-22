import { useEffect, useRef, useState } from "react";
import { api, type RoutingExplanation, type TaskDetail as Detail, type TaskEvent } from "./api.js";
import { Button, Card, StateBadge, tokens } from "./ui.jsx";

type Tab = "activity" | "usage" | "routing" | "progress";

interface PendingApproval {
  requestId: string;
  summary: string;
}

export function TaskDetail({ taskId, onBack }: { taskId: string; onBack: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [state, setState] = useState<string>("");
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const [routing, setRouting] = useState<Array<{ chosen: string | null; at: string; explanation: RoutingExplanation }>>([]);
  const [tab, setTab] = useState<Tab>("activity");
  const timelineRef = useRef<HTMLDivElement>(null);

  const refresh = () => {
    void api.task(taskId).then((d) => {
      setDetail(d);
      setState(d.state);
    });
    void api.routing(taskId).then(setRouting);
  };

  useEffect(() => {
    void api.events(taskId).then(setEvents);
    refresh();

    // Live tail: SSE carries normalized events and authoritative state changes.
    const source = new EventSource(`/api/tasks/${taskId}/events/stream`);
    source.onmessage = (msg) => {
      const payload = JSON.parse(msg.data) as {
        kind: "event" | "state";
        event?: TaskEvent;
        state?: { state: string };
      };
      if (payload.kind === "state" && payload.state) {
        setState(payload.state.state);
        refresh();
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
        {detail.active && (
          <Button variant="danger" onClick={() => void api.cancel(taskId).then(refresh)}>
            Cancel
          </Button>
        )}
      </div>
      <p style={{ marginTop: 0, color: tokens.muted }}>{detail.goal}</p>

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
        {(["activity", "usage", "routing", "progress"] as Tab[]).map((t) => (
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
