import { useState } from "react";
import { api, type RoutingExplanation } from "./api.js";
import { Button, Card, Field, inputStyle, QuotaBar, tokens } from "./ui.jsx";

export function NewTask({ onStarted }: { onStarted: (taskId: string) => void }) {
  const [goal, setGoal] = useState("");
  const [constraints, setConstraints] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [profile, setProfile] = useState("auto");
  const [taskId, setTaskId] = useState<string | null>(null);
  const [explanation, setExplanation] = useState<RoutingExplanation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: "1.5rem" }}>
      <Card>
        <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>New task</h2>
        <Field label="Goal">
          <textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            rows={4}
            placeholder="Fix the authentication refresh-token race and raise coverage"
            style={{ ...inputStyle, resize: "vertical" }}
          />
        </Field>
        <Field label="Constraints (one per line — recorded as user decisions, inviolable on handoff)">
          <textarea
            value={constraints}
            onChange={(e) => setConstraints(e.target.value)}
            rows={2}
            placeholder="no breaking changes"
            style={{ ...inputStyle, resize: "vertical" }}
          />
        </Field>
        <Field label="Repository path (must be in the workspace allowlist)">
          <input value={repoPath} onChange={(e) => setRepoPath(e.target.value)} style={inputStyle} />
        </Field>
        <Field label="Routing profile">
          <select value={profile} onChange={(e) => setProfile(e.target.value)} style={inputStyle}>
            <option value="auto">Auto</option>
            <option value="preserve-quota">Preserve Quota</option>
            <option value="fastest">Fastest (measured)</option>
            <option value="best-quality">Best Quality (measured)</option>
            <option value="lowest-tokens">Lowest Tokens (measured)</option>
          </select>
        </Field>
        <Button onClick={previewRoute} disabled={busy || goal.trim().length === 0}>
          {taskId ? "Re-route" : "Preview routing"}
        </Button>
        {explanation && explanation.candidates.filter((c) => c.passedFilters).length > 1 && (
          <p style={{ fontSize: "0.8rem", color: tokens.muted, marginTop: "0.8rem" }}>
            Running in parallel multiplies quota and token spend, so it is never automatic — use the buttons
            in the recommendation panel to compare or race deliberately.
          </p>
        )}
        {error && <p style={{ color: tokens.danger, fontSize: "0.85rem" }}>{error}</p>}
      </Card>

      <Card>
        <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>Routing recommendation</h2>
        {!explanation && (
          <p style={{ color: tokens.muted, fontSize: "0.9rem" }}>
            Submit a goal to see which assistant the router picks — and exactly why.
          </p>
        )}
        {explanation && (
          <>
            <p style={{ fontSize: "0.85rem", color: tokens.muted, margin: "0 0 0.75rem" }}>
              Rule fired: <code style={{ fontFamily: tokens.mono }}>{explanation.ruleFired}</code>
              {explanation.tieBreaker ? ` · ${explanation.tieBreaker}` : ""}
            </p>
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
            {explanation.chosen ? (
              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                <Button onClick={() => void start()} disabled={busy}>
                  Run recommended
                </Button>
                {eligible.length > 1 && (
                  <>
                    <Button variant="secondary" disabled={busy} onClick={() => void startParallel("compare")}>
                      Compare {eligible.length}
                    </Button>
                    <Button variant="secondary" disabled={busy} onClick={() => void startParallel("race")}>
                      Race {eligible.length}
                    </Button>
                  </>
                )}
              </div>
            ) : (
              <p style={{ color: tokens.danger, fontSize: "0.85rem" }}>
                No eligible assistant — every candidate failed a hard filter.
              </p>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
