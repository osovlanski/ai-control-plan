import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TaskSummary } from "../api.js";
import { fieldPulse } from "../orbital.js";
import { CalmOverview } from "./CalmOverview.js";
import { DIAGNOSTICS_KEY, readDiagnostics, writeDiagnostics } from "./diagnosticsPref.js";

const task = (id: string, state: string, goal = `Goal ${id}`): TaskSummary => ({
  id, goal, state, phase: null, profile: "auto", repoPath: null, createdAt: "2026-11-20T10:00:00.000Z", updatedAt: "2026-11-20T10:00:00.000Z",
});
const noop = vi.fn();
const render = (tasks: TaskSummary[], over: Partial<Parameters<typeof CalmOverview>[0]> = {}) =>
  renderToStaticMarkup(<CalmOverview tasks={tasks} current={tasks[0]} snapshot={null} pulse={fieldPulse(tasks)}
    loading={false} error={null} onSelect={noop} onOpen={noop} onNewMission={noop} onShowAll={noop} {...over} />);

describe("calm Overview", () => {
  it("names the one mission that needs a person and says how to act on it", () => {
    const html = render([task("AG-1", "WAITING_INPUT", "Harden the webhook"), task("AG-2", "COMPLETED")]);
    expect(html).toContain("Needs you");
    expect(html).toContain("Harden the webhook");
    expect(html).toContain("Review and decide");
    expect(html).toContain("<b>1</b> need you");
  });
  it("offers a jump to the next mission that needs you without hiding the current one", () => {
    const html = render([task("AG-1", "RUNNING"), task("AG-2", "WAITING_INPUT"), task("AG-3", "LIMIT_PAUSED")]);
    expect(html).toContain("Watch this mission");
    expect(html).toContain("2 more missions need you");
  });
  it("keeps a short mission list and points at diagnostics for the rest", () => {
    const tasks = Array.from({ length: 7 }, (_, i) => task(`AG-${i}`, "COMPLETED"));
    const html = render(tasks);
    expect(html.match(/aria-pressed/g)).toHaveLength(5);
    expect(html).toContain("All 7 in diagnostics");
  });
  it("does not claim counts or an action before the first read", () => {
    const html = render([], { current: undefined, loading: true });
    expect(html).toContain("Reading your workspace…");
    expect(html).not.toContain("Describe a goal");
    expect(html).not.toContain("Mission counts");
  });
  it("says so when the read failed and nothing was ever loaded", () => {
    const html = render([], { current: undefined, error: "503" });
    expect(html).toContain("Mission state unavailable");
    expect(html).not.toContain("Describe a goal");
  });
  it("invites the first goal on an empty workspace", () => {
    const html = render([], { current: undefined });
    expect(html).toContain("Your first mission starts here.");
    expect(html).toContain("Describe a goal");
  });
  it("labels a stale snapshot instead of passing it off as fresh", () => {
    expect(render([task("AG-1", "RUNNING")], { error: "boom" })).toContain("Last successful snapshot");
  });
});

describe("diagnostics preference", () => {
  const store = (initial?: string) => {
    const data = new Map<string, string>(initial ? [[DIAGNOSTICS_KEY, initial]] : []);
    return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
  };
  it("defaults to calm", () => expect(readDiagnostics(store())).toBe(false));
  it("round-trips the choice", () => {
    const s = store();
    writeDiagnostics(true, s);
    expect(readDiagnostics(s)).toBe(true);
    writeDiagnostics(false, s);
    expect(readDiagnostics(s)).toBe(false);
  });
  it("survives storage that throws or is missing", () => {
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(readDiagnostics(broken)).toBe(false);
    expect(() => writeDiagnostics(true, broken)).not.toThrow();
    expect(readDiagnostics(undefined)).toBe(false);
  });
});
