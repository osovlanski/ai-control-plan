/**
 * M14 K9 — read the current/latest truthful context state for a task's active
 * session. Observation only: this module never compacts, yields or continues.
 *
 * Truthful outcomes (kernel-services §4.3): KNOWN (occupancy + effective window
 * + source + freshness) or UNAVAILABLE. A percentage is returned ONLY when a
 * fresh observation has both occupancy and a real effective window — never
 * synthesised from accounting or the advertised maximum. The legacy execution
 * path reports UNAVAILABLE explicitly rather than a synthesised parity value.
 */
import type { ContextCapability, ContextObservation } from "@agent-plane/core";
import type { Db } from "../db/index.js";
import { effectiveStateSql } from "./harness/state-vocab.js";

/** An observation older than this (or on a terminal session) renders `stale`. */
export const CONTEXT_STALE_MS = 45_000;
const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT", "YIELDED"]);

export interface TaskContextResponse {
  status: "known" | "unavailable";
  sessionId?: string;
  /** Why nothing truthful can be shown (unavailable), or extra context (known). */
  reason?: string;
  capability?: ContextCapability;
  observation?: ContextObservation & { freshness: "live" | "stale" };
  autoCompaction?: { observed: boolean; count: number; lastAt?: string; trigger?: string };
}

export interface ReadTaskContextDeps {
  now: () => Date;
  capabilityFor: (assistantId: string) => ContextCapability | undefined;
  /**
   * K7 catalog seam — resolves an advertised maximum ONLY from a KNOWN resolved
   * model id. Never converts a catalog maximum into an effective managed window.
   */
  advertisedMaxFor?: (provider: string, resolvedModelId: string) => number | undefined;
}

function safeParse(json: string | null): Record<string, unknown> | undefined {
  if (!json) return undefined;
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function readTaskContext(db: Db, taskId: string, deps: ReadTaskContextDeps): TaskContextResponse {
  const run = db
    .prepare(
      `SELECT r.id AS id, r.assistant_id AS assistant_id, r.execution_request_id AS execution_request_id,
              ${effectiveStateSql("r")} AS state, r.model_resolved AS model_resolved, a.provider AS provider
       FROM runs r LEFT JOIN assistants a ON a.id = r.assistant_id
       WHERE r.task_id = ? ORDER BY r.started_at DESC, r.rowid DESC LIMIT 1`,
    )
    .get(taskId) as
    | {
        id: string;
        assistant_id: string;
        execution_request_id: string | null;
        state: string;
        model_resolved: string | null;
        provider: string | null;
      }
    | undefined;

  if (!run) return { status: "unavailable", reason: "no execution session for this task" };
  // The legacy path cannot produce the observation contract — say so, don't fake parity.
  if (run.execution_request_id === null) {
    return { status: "unavailable", sessionId: run.id, reason: "legacy execution path" };
  }

  const capability = deps.capabilityFor(run.assistant_id);

  const compRows = db
    .prepare(
      `SELECT payload, ts FROM events WHERE run_id = ? AND type = 'context.compaction.observed' ORDER BY seq DESC`,
    )
    .all(run.id) as Array<{ payload: string | null; ts: string }>;
  const autoCompaction = compRows.length
    ? {
        observed: true,
        count: compRows.length,
        lastAt: compRows[0]!.ts,
        trigger: safeParse(compRows[0]!.payload)?.trigger as string | undefined,
      }
    : { observed: false, count: 0 };

  const obsRow = db
    .prepare(
      `SELECT payload, ts FROM events WHERE run_id = ? AND type = 'context.observed' ORDER BY seq DESC LIMIT 1`,
    )
    .get(run.id) as { payload: string | null; ts: string } | undefined;

  if (!obsRow?.payload) {
    return {
      status: "unavailable",
      sessionId: run.id,
      capability,
      autoCompaction: autoCompaction.observed ? autoCompaction : undefined,
      reason:
        !capability || capability.occupancy === "unavailable"
          ? `${run.provider ?? "this provider"} does not expose live context occupancy`
          : "no context observation recorded yet",
    };
  }

  const raw = safeParse(obsRow.payload) as ContextObservation | undefined;
  if (!raw) {
    return { status: "unavailable", sessionId: run.id, capability, reason: "context observation unreadable" };
  }

  const ageMs = deps.now().getTime() - Date.parse(obsRow.ts);
  const stale = TERMINAL.has(run.state) || !Number.isFinite(ageMs) || ageMs > CONTEXT_STALE_MS;

  let advertisedMaxTokens = raw.advertisedMaxTokens;
  if (advertisedMaxTokens === undefined && run.model_resolved && run.provider && deps.advertisedMaxFor) {
    advertisedMaxTokens = deps.advertisedMaxFor(run.provider, run.model_resolved);
  }

  return {
    status: "known",
    sessionId: run.id,
    capability,
    autoCompaction,
    observation: {
      ...raw,
      advertisedMaxTokens,
      freshness: stale ? "stale" : "live",
      // A stale observation never masquerades as a live pressure reading.
      pressure: stale ? undefined : raw.pressure,
    },
  };
}
