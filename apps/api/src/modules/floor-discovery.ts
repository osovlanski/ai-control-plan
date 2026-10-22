/**
 * M16 K19i — the judge as an OFFLINE floor discovery job (plan §5 K19i).
 *
 * The judge left the hot path because text in a command moves it (K19h). Here
 * that instability costs nothing: the job reads recent tool calls, drops every
 * call a floor already prompts on, asks the judge about the rest, and writes
 * the ones it would supervise as FLOOR CANDIDATES for a human to accept or
 * reject. It proposes; it never gates, and nothing it writes is read by the
 * gate. A candidate becomes a floor only when someone writes the rule and its
 * tests in `packages/core/src/tool-floors.ts`.
 */
import {
  TOOL_GATE_BATTERY,
  TOOL_GATE_BUDGET_MS,
  buildToolGateState,
  resolveToolGate,
  toolActionFromEvent,
  toolGateFloorHits,
  type DecisionOutcome,
  type DecisionRequest,
  type McpToolPolicy,
  type ToolAction,
} from "@agent-plane/core";
import type { ResolvedDecisionsConfig } from "../config.js";
import type { Db } from "../db/index.js";
import type { DecisionServiceConfig } from "./decision.js";

/**
 * The Jev version floor discovery sends, pinned so a vendor alias move cannot
 * change what the job measured (2026-10-04: 29/29 corpus floors, p50 303 ms).
 */
export const DISCOVERY_TYPESAFE_MODEL = "jev-1.13";

export type DiscoveryJudgeId = "typesafe" | "model";

export interface DiscoveryJudge {
  /** The judge asked first. `typesafe` falls back to `model`, then to rules (unjudged). */
  first: DiscoveryJudgeId;
  config: DecisionServiceConfig;
  /** Why the configured judge was not used, for the operator. */
  note?: string;
}

/**
 * Which judge the job asks (`decisions.discoveryProvider`), and the chain behind
 * it. I-D7: only the `personal` workspace may send state to TypeSafe, and the
 * state here is the INPUT's tool calls, so the input must be the personal
 * workspace's too. Input of another or unknown workspace is judged by `model`.
 */
export function discoveryJudge(opts: {
  workspace: string;
  decisions: Pick<ResolvedDecisionsConfig, "discoveryProvider" | "typesafeApiKeyRef" | "typesafeRoute">;
  /** The workspace the tool calls came from; undefined when the caller cannot say. */
  inputWorkspace: string | undefined;
}): DiscoveryJudge {
  const { workspace, decisions, inputWorkspace } = opts;
  const model: DiscoveryJudge = { first: "model", config: { provider: "model" } };
  if (decisions.discoveryProvider !== "typesafe") return model;
  if (!decisions.typesafeApiKeyRef) return { ...model, note: "decisions.discoveryProvider: typesafe has no typesafeApiKeyRef; judging with model" };
  if (workspace !== "personal" || inputWorkspace !== "personal") {
    const from = inputWorkspace === undefined ? "of unknown workspace" : `from workspace "${inputWorkspace}"`;
    return { ...model, note: `input ${from} may not be sent to TypeSafe (I-D7, personal only); judging with model` };
  }
  return {
    first: "typesafe",
    config: {
      provider: "typesafe",
      typesafeApiKeyRef: decisions.typesafeApiKeyRef,
      ...(decisions.typesafeRoute ? { typesafeRoute: decisions.typesafeRoute } : {}),
      typesafeModel: DISCOVERY_TYPESAFE_MODEL,
    },
  };
}

export interface RecentToolAction extends ToolAction {
  worktreePath?: string;
  seenAt: string;
}

/**
 * The tool calls the plane recorded, newest first. Events are redacted before
 * they are stored (EventRecorder), so no raw secret reaches the judge from here.
 */
export function readRecentToolActions(db: Db, opts: { limit?: number } = {}): RecentToolAction[] {
  const rows = db
    .prepare(
      `SELECT e.ts, e.summary, e.payload, COALESCE(r.worktree_path, t.worktree_path) AS worktree_path
         FROM events e
         JOIN runs r ON r.id = e.run_id
         LEFT JOIN tasks t ON t.id = r.task_id
        WHERE e.type IN ('tool.started', 'approval.requested')
        ORDER BY e.id DESC
        LIMIT ?`,
    )
    .all(Math.min(Math.max(opts.limit ?? 2_000, 1), 50_000)) as Array<{
    ts: string;
    summary: string | null;
    payload: string | null;
    worktree_path: string | null;
  }>;
  const out: RecentToolAction[] = [];
  for (const row of rows) {
    let payload: unknown;
    try {
      payload = row.payload ? JSON.parse(row.payload) : undefined;
    } catch {
      continue; // a corrupt payload is not a command
    }
    out.push({ ...toolActionFromEvent(payload, row.summary ?? undefined), worktreePath: row.worktree_path ?? undefined, seenAt: row.ts });
  }
  return out;
}

export interface FloorCandidate {
  toolName: string;
  /** Clipped for a human to read; the redacted form the plane stored. */
  commandText: string;
  occurrences: number;
  lastSeen: string;
  /** The judge's own verdict reason, e.g. `judged: risk=medium, outside_repo=0.85`. An explanation, not a probability to trust. */
  judgeReason: string;
  /** The judge that answered. */
  judge: DiscoveryJudgeId;
  /** Set when a judge earlier in the chain failed and `judge` answered in its place. */
  fallbackFrom?: string;
}

export interface DiscoveryReport {
  scanned: number;
  distinct: number;
  /** Already prompted by a floor; never sent to the judge. */
  floored: number;
  judged: number;
  /** Judged calls per judge that answered. */
  judgedBy: Record<DiscoveryJudgeId, number>;
  /** Judged calls answered by a fallback judge after the first one failed. */
  fallbacks: number;
  /** Distinct reasons the first judge failed on those calls. */
  fallbackReasons: string[];
  /** The judge did not answer (no credential, a timeout, an error). Counted, never guessed. */
  unjudged: number;
  /** Distinct reasons the judge did not answer, as the service reported them (never the secret). */
  unjudgedReasons: string[];
  candidates: FloorCandidate[];
}

const CLIP = 400;

/** Pure over its inputs apart from `decide`, which is the judge. */
export async function discoverFloorCandidates(
  actions: readonly RecentToolAction[],
  decide: (req: DecisionRequest) => Promise<DecisionOutcome>,
  mcpTools?: McpToolPolicy,
): Promise<DiscoveryReport> {
  const groups = new Map<string, { action: RecentToolAction; occurrences: number; lastSeen: string }>();
  for (const a of actions) {
    const key = `${a.toolName}\u0000${a.commandText ?? ""}`;
    const g = groups.get(key);
    if (g) {
      g.occurrences += 1;
      if (a.seenAt > g.lastSeen) g.lastSeen = a.seenAt;
    } else groups.set(key, { action: a, occurrences: 1, lastSeen: a.seenAt });
  }
  const report: DiscoveryReport = {
    scanned: actions.length,
    distinct: groups.size,
    floored: 0,
    judged: 0,
    judgedBy: { typesafe: 0, model: 0 },
    fallbacks: 0,
    fallbackReasons: [],
    unjudged: 0,
    unjudgedReasons: [],
    candidates: [],
  };
  for (const { action, occurrences, lastSeen } of groups.values()) {
    const observation = { toolName: action.toolName, commandText: action.commandText, paths: action.paths, worktreePath: action.worktreePath };
    if (toolGateFloorHits({ ...observation, shell: action.shell, mcpTools }).length > 0) {
      report.floored += 1;
      continue;
    }
    const outcome = await decide({
      site: "tool-gate",
      state: buildToolGateState(observation).state,
      questions: TOOL_GATE_BATTERY,
      budgetMs: TOOL_GATE_BUDGET_MS.shadow,
    });
    // Rules answering means no judge did. A judge answering with `degraded` is a
    // fallback judge's real answer (typesafe failed, model answered), so it counts.
    if (outcome.provider === "rules") {
      report.unjudged += 1;
      const why = outcome.degraded?.reason ?? "no judging provider in the chain";
      if (!report.unjudgedReasons.includes(why)) report.unjudgedReasons.push(why);
      continue;
    }
    const judge = outcome.provider;
    report.judged += 1;
    report.judgedBy[judge] += 1;
    if (outcome.degraded) {
      report.fallbacks += 1;
      if (!report.fallbackReasons.includes(outcome.degraded.reason)) report.fallbackReasons.push(outcome.degraded.reason);
    }
    // auto-approve: the one mode where a judge-raised prompt is the only prompt.
    // The gate prompts on ANY degraded outcome before it reads an answer, so the
    // fallback judge's answer is read without the note; the fallback is counted above.
    const { degraded: _fellBack, ...answered } = outcome;
    const verdict = resolveToolGate({ rulesDenied: false, approvalMode: "auto-approve", outcome: answered });
    if (verdict.outcome !== "prompt") continue;
    report.candidates.push({
      toolName: action.toolName,
      commandText: (action.commandText ?? "").slice(0, CLIP),
      occurrences,
      lastSeen,
      judgeReason: verdict.reason,
      judge,
      ...(outcome.degraded ? { fallbackFrom: outcome.degraded.from } : {}),
    });
  }
  report.candidates.sort((a, b) => b.occurrences - a.occurrences || (a.lastSeen < b.lastSeen ? 1 : -1));
  return report;
}

/** The file a human reads: each candidate, why the judge flagged it, and what accepting it means. */
export function renderCandidates(report: DiscoveryReport, generatedAt: string, judge?: Pick<DiscoveryJudge, "first" | "note">): string {
  const lines = [
    "# Floor candidates (M16 K19i — proposed by the judge, not active)",
    "",
    `Generated ${generatedAt}. The judge PROPOSES; nothing here gates a tool call.`,
    "Accept a candidate by writing a floor for it in `packages/core/src/tool-floors.ts` with a test in",
    "`packages/core/test/tool-floors.test.ts`. Reject one by leaving it: it reappears while it recurs,",
    "which is the signal to either floor it or note in the floor file why it stays unfloored.",
    "",
    `Scanned ${report.scanned} tool calls (${report.distinct} distinct): ${report.floored} already floored, ` +
      `${report.judged} judged, ${report.unjudged} unjudged, ${report.candidates.length} candidates.`,
    "",
  ];
  if (judge) {
    const chain = judge.first === "typesafe" ? `typesafe (${DISCOVERY_TYPESAFE_MODEL}) → model → rules` : "model → rules";
    lines.push(`Judge chain: ${chain}.${judge.note ? ` ${judge.note}.` : ""}`);
  }
  lines.push(
    `Judged by typesafe ${report.judgedBy.typesafe}, model ${report.judgedBy.model}; ${report.fallbacks} fallback${report.fallbacks === 1 ? "" : "s"}` +
      (report.fallbackReasons.length ? ` (${report.fallbackReasons.join("; ")}).` : "."),
    "",
  );
  if (report.judged === 0 && report.distinct > report.floored) {
    lines.push(
      `**No judgement ran** (${report.unjudgedReasons.join("; ") || "no judge"}). Nothing below is evidence of an absence.`,
      "",
    );
  }
  for (const c of report.candidates) {
    lines.push(`## \`${c.toolName}\` × ${c.occurrences} (last ${c.lastSeen})`, "", "```text", c.commandText, "```", "", `Judge (${c.fallbackFrom ? `${c.judge} fallback from ${c.fallbackFrom}` : c.judge}): ${c.judgeReason}`, "");
  }
  return `${lines.join("\n")}\n`;
}
