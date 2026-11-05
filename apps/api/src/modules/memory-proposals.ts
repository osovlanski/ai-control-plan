import { createHash } from "node:crypto";
import {
  deriveMemoryProposals,
  reliabilityClass,
  type AgentSpec,
  type ExecutionResult,
  type MemoryProposal,
  type MemoryProposalDerivation,
  type MemoryProposalGuard,
  type MemoryProposalHarness,
} from "@agent-plane/core";
import type { Db } from "../db/index.js";
import {
  MEMORY_PROPOSAL_PAGE_DEFAULT,
  MEMORY_PROPOSAL_PAGE_MAX,
  MEMORY_SCHEMA_VERSION,
  memoryProposalGuardHits,
  type MemoryProposalEvent,
  type MemoryProposalPage,
} from "../memory-contract.js";

/**
 * O6 S5: memory proposals from settled composed sessions (plan §2.3), and the feed Cockpit pulls
 * (`GET /api/memory/proposals`, `memory.read`, memory v1). The plane only proposes: nothing in
 * this module, or anywhere in the plane, writes operator memory.
 */

/** The contract's own guards (memory-contract.ts), classified for the pure parser. */
function guardHits(entry: { name: string; description: string; body: string }): MemoryProposalGuard[] {
  const found = new Set<MemoryProposalGuard>();
  for (const hit of memoryProposalGuardHits(entry)) {
    if (hit.endsWith("an inline credential")) found.add("credential");
    else if (hit.endsWith("an absolute path")) found.add("absolute_path");
    else if (hit.endsWith("a hostname or address")) found.add("hostname");
  }
  // Fixed priority, so the counted reason does not depend on field order.
  return (["credential", "absolute_path", "hostname"] as const).filter((g) => found.has(g));
}

const deps = { sha256: (text: string) => createHash("sha256").update(text, "utf8").digest("hex"), guardHits };

interface Logger {
  warn(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
}

export type ProposeOutcome =
  | { status: "proposed" | "skipped"; proposals: number; inserted: number; conflicts: number; dropped: number; skipReason?: string }
  | { status: "not_eligible"; reason: "no_session" | "no_revision" | "not_settled" }
  | { status: "error" };

const HARNESSES = new Set<string>(["claude-code", "codex", "cursor", "bedrock"]);

/** `N files changed` from a `git diff --stat` summary line; 0 when there is none. */
export function changedFilesOf(diffStat: string | null): number {
  const m = diffStat ? /(\d+) files? changed/.exec(diffStat) : null;
  return m ? Number(m[1]) : 0;
}

/**
 * Called from the orchestrator's settle path once a session has a terminal result, and by the boot
 * backfill. A replay inserts nothing; a different body under a stored id is a counted conflict and
 * the stored row stays. It never throws: a proposal must not fail a settle.
 */
export class MemoryProposals {
  conflicts = 0;

  constructor(private db: Db, private log?: Logger) {}

  propose(sessionId: string): ProposeOutcome {
    try {
      return this.proposeOrThrow(sessionId);
    } catch (err) {
      // The session id and the error class only: an error message could quote the message text.
      this.log?.warn({ sessionId, err: err instanceof Error ? err.name : "unknown" }, "memory proposal extraction failed");
      return { status: "error" };
    }
  }

  /** Evaluates every settled revision-bound session with no extraction ledger row (a crash between settle and extraction, or a session settled before S5). */
  backfill(): { evaluated: number; inserted: number; conflicts: number } {
    const ids = this.db.prepare(
      `SELECT r.id FROM runs r JOIN execution_results er ON er.session_id = r.id
       WHERE r.composition_revision_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM memory_proposal_sessions s WHERE s.session_id = r.id)
       ORDER BY er.at, r.id`,
    ).all() as Array<{ id: string }>;
    let evaluated = 0, inserted = 0, conflicts = 0;
    for (const { id } of ids) {
      const out = this.propose(id);
      if (out.status !== "proposed" && out.status !== "skipped") continue;
      evaluated += 1;
      inserted += out.inserted;
      conflicts += out.conflicts;
    }
    if (evaluated) this.log?.info({ evaluated, inserted, conflicts }, "memory proposals backfilled");
    return { evaluated, inserted, conflicts };
  }

  /** Reads the session's settled inputs and derives, without storing. Exposed for tests. */
  derive(sessionId: string): MemoryProposalDerivation | Extract<ProposeOutcome, { status: "not_eligible" }> {
    const run = this.db.prepare(
      `SELECT r.task_id, r.composition_revision_id, r.model_resolved, er.result
       FROM runs r LEFT JOIN execution_results er ON er.session_id = r.id WHERE r.id = ?`,
    ).get(sessionId) as { task_id: string; composition_revision_id: string | null; model_resolved: string | null; result: string | null } | undefined;
    if (!run) return { status: "not_eligible", reason: "no_session" };
    if (!run.composition_revision_id) return { status: "not_eligible", reason: "no_revision" };
    if (!run.result) return { status: "not_eligible", reason: "not_settled" };
    const result = JSON.parse(run.result) as ExecutionResult;
    const spec = JSON.parse((this.db.prepare("SELECT spec_json FROM agent_specs WHERE composition_revision_id = ?")
      .get(run.composition_revision_id) as { spec_json: string }).spec_json) as AgentSpec;

    // Only the checkpoint the result names, and only if it is this session's completion checkpoint.
    const checkpointId = result.checkpoint?.checkpointId;
    const checkpoint = checkpointId
      ? this.db.prepare("SELECT id, reason, at, diff_stat FROM checkpoints WHERE id = ? AND session_id = ?").get(checkpointId, sessionId) as
        { id: string; reason: string; at: string; diff_stat: string | null } | undefined
      : undefined;

    const provisioning = this.db.prepare(
      "SELECT type, payload FROM events WHERE run_id = ? AND type IN ('provisioning.verified', 'provisioning.ambient') ORDER BY seq",
    ).all(sessionId) as Array<{ type: string; payload: string | null }>;
    const verified = provisioning.find((e) => e.type === "provisioning.verified");
    const fidelity = verified?.payload ? (JSON.parse(verified.payload) as { fidelity?: string }).fidelity : undefined;
    const ambient = provisioning.some((e) => e.type === "provisioning.ambient") || !fidelity || fidelity === "none";

    // The last message only: no transcript is read beyond it (plan §2.3).
    const last = this.db.prepare("SELECT summary, payload FROM events WHERE run_id = ? AND type = 'message' ORDER BY seq DESC LIMIT 1")
      .get(sessionId) as { summary: string; payload: string | null } | undefined;
    const text = last?.payload ? (JSON.parse(last.payload) as { text?: unknown }).text : undefined;
    const lastMessage = typeof text === "string" ? text : (last?.summary ?? null);

    const verification = result.verification;
    const verificationPassed = !verification ? null : verification.checks.some((c) => c.status !== "skipped") ? verification.passed : null;

    if (!HARNESSES.has(spec.harness)) throw new Error("memory proposals: unknown harness");
    return deriveMemoryProposals({
      sessionId,
      taskId: run.task_id,
      compositionRevisionId: run.composition_revision_id,
      harness: spec.harness as MemoryProposalHarness,
      model: run.model_resolved,
      outcome: reliabilityClass(result),
      ambient,
      checkpoint: checkpoint ? { id: checkpoint.id, at: checkpoint.at, reason: checkpoint.reason } : null,
      verificationPassed,
      changedFiles: changedFilesOf(checkpoint?.diff_stat ?? null),
      pinnedBundles: spec.context.memory_bundles.map(({ id, digest }) => ({ id, digest })),
      lastMessage,
    }, deps);
  }

  private proposeOrThrow(sessionId: string): ProposeOutcome {
    const derived = this.derive(sessionId);
    if (derived.status === "not_eligible") return derived;
    // The settled result's time, never the clock: a re-derivation writes the same ledger row.
    const { composition_revision_id: revision, at: settledAt } = this.db.prepare(
      "SELECT r.composition_revision_id, er.at FROM runs r JOIN execution_results er ON er.session_id = r.id WHERE r.id = ?",
    ).get(sessionId) as { composition_revision_id: string; at: string };

    let inserted = 0, conflicts = 0;
    const conflict = (key: string) => {
      conflicts += 1;
      this.conflicts += 1;
      this.log?.warn({ key, parserVersion: derived.parserVersion }, "memory proposal conflict: a different body under a stored key; the stored row stays");
    };
    const insert = this.db.prepare(
      `INSERT INTO memory_proposals (proposal_id, ingest_seq, session_id, task_id, composition_revision_id, checkpoint_id, entry_index,
         harness, model, kind, name, description, body, target_bundle_id, target_bundle_digest, supersedes_json, outcome,
         verification_passed, changed_files, parser_version, body_digest, at)
       VALUES (?, (SELECT COALESCE(MAX(ingest_seq), 0) + 1 FROM memory_proposals), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    );
    const stored = this.db.prepare("SELECT body_digest FROM memory_proposals WHERE proposal_id = ? OR (session_id = ? AND entry_index = ?)");
    const droppedTotal = Object.values(derived.dropped).reduce((a, b) => a + (b ?? 0), 0);
    const dropped = Object.fromEntries(Object.entries(derived.dropped).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    const ledger = {
      status: derived.status, skipReason: derived.skipReason ?? null, proposals: derived.proposals.length, dropped,
      truncated: derived.truncated, untargeted: derived.untargeted, parserVersion: derived.parserVersion,
      proposalDigests: derived.proposals.map((p) => p.bodyDigest),
    };
    const ledgerDigest = `sha256:${deps.sha256(JSON.stringify(ledger))}`;

    this.db.transaction(() => {
      for (const p of derived.proposals) {
        if (insert.run(...params(p, derived.parserVersion)).changes) { inserted += 1; continue; }
        const prior = stored.get(p.proposalId, p.sessionId, p.index) as { body_digest: string };
        if (prior.body_digest !== p.bodyDigest) conflict(p.proposalId);
      }
      const done = this.db.prepare(
        `INSERT INTO memory_proposal_sessions (session_id, composition_revision_id, status, skip_reason, proposals, dropped_json,
           truncated, untargeted, parser_version, body_digest, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id) DO NOTHING`,
      ).run(sessionId, revision, derived.status, derived.skipReason ?? null, derived.proposals.length, JSON.stringify(dropped),
        derived.truncated, derived.untargeted, derived.parserVersion, ledgerDigest, settledAt);
      if (!done.changes) {
        const prior = this.db.prepare("SELECT body_digest FROM memory_proposal_sessions WHERE session_id = ?").get(sessionId) as { body_digest: string };
        if (prior.body_digest !== ledgerDigest) conflict(`session:${sessionId}`);
      }
    })();
    if (inserted || droppedTotal || derived.truncated) {
      // Counts and reasons only: never a proposal's text.
      this.log?.info({ sessionId, inserted, dropped, truncated: derived.truncated, untargeted: derived.untargeted }, "memory proposals extracted");
    }
    return {
      status: derived.status, proposals: derived.proposals.length, inserted, conflicts, dropped: droppedTotal,
      ...(derived.skipReason ? { skipReason: derived.skipReason } : {}),
    };
  }
}

const bit = (b: boolean | null) => (b === null ? null : b ? 1 : 0);

function params(p: MemoryProposal, parserVersion: number): Array<string | number | null> {
  return [
    p.proposalId, p.sessionId, p.taskId, p.compositionRevisionId, p.checkpointId, p.index, p.harness, p.model, p.kind, p.name,
    p.description, p.body, p.target?.bundleId ?? null, p.target?.bundleDigest ?? null, JSON.stringify(p.supersedes),
    p.evidence.outcome, bit(p.evidence.verificationPassed), p.evidence.changedFiles, parserVersion, p.bodyDigest, p.at,
  ];
}

// ---- Feed (memory v1, `GET /api/memory/proposals`) ----

export type MemoryFeedQuery = { ok: true; after: number; limit: number } | { ok: false; error: string };
const DIGITS = /^(0|[1-9][0-9]*)$/;

/** `after` 0..2^53−1 (default 0), `limit` 1..100 (default 100); anything else is a 400 message. */
export function parseMemoryFeedQuery(query: { after?: unknown; limit?: unknown } | undefined): MemoryFeedQuery {
  const read = (name: string, raw: unknown, fallback: number, min: number, max: number): number | string => {
    if (raw === undefined) return fallback;
    if (typeof raw !== "string" || !DIGITS.test(raw)) return `${name} must be an integer from ${min} to ${max}`;
    const n = Number(raw);
    return n < min || n > max ? `${name} must be an integer from ${min} to ${max}` : n;
  };
  const after = read("after", query?.after, 0, 0, Number.MAX_SAFE_INTEGER);
  if (typeof after === "string") return { ok: false, error: after };
  const limit = read("limit", query?.limit, MEMORY_PROPOSAL_PAGE_DEFAULT, 1, MEMORY_PROPOSAL_PAGE_MAX);
  if (typeof limit === "string") return { ok: false, error: limit };
  return { ok: true, after, limit };
}

interface ProposalRow {
  proposal_id: string;
  ingest_seq: number;
  session_id: string;
  task_id: string;
  composition_revision_id: string;
  checkpoint_id: string;
  harness: MemoryProposalEvent["harness"];
  model: string | null;
  kind: MemoryProposalEvent["kind"];
  name: string;
  description: string;
  body: string;
  target_bundle_id: string | null;
  target_bundle_digest: string | null;
  supersedes_json: string;
  verification_passed: number | null;
  changed_files: number;
  at: string;
}

function toEvent(r: ProposalRow): MemoryProposalEvent {
  return {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    proposalId: r.proposal_id,
    seq: r.ingest_seq,
    sessionId: r.session_id,
    taskId: r.task_id,
    compositionRevisionId: r.composition_revision_id,
    checkpointId: r.checkpoint_id,
    harness: r.harness,
    model: r.model,
    kind: r.kind,
    name: r.name,
    description: r.description,
    body: r.body,
    target: r.target_bundle_id !== null && r.target_bundle_digest !== null ? { bundleId: r.target_bundle_id, bundleDigest: r.target_bundle_digest } : null,
    supersedes: JSON.parse(r.supersedes_json) as string[],
    evidence: { outcome: "success", verificationPassed: r.verification_passed === null ? null : r.verification_passed === 1, changedFiles: r.changed_files },
    at: r.at,
  };
}

/** Proposals with `seq > after` in seq order, at most `limit`; `next` is the last seq or `after`. */
export function readMemoryProposalPage(db: Db, after: number, limit: number): MemoryProposalPage {
  const rows = db.prepare(
    `SELECT proposal_id, ingest_seq, session_id, task_id, composition_revision_id, checkpoint_id, harness, model, kind, name,
       description, body, target_bundle_id, target_bundle_digest, supersedes_json, verification_passed, changed_files, at
     FROM memory_proposals WHERE ingest_seq > ? ORDER BY ingest_seq LIMIT ?`,
  ).all(after, Math.min(Math.max(limit, 1), MEMORY_PROPOSAL_PAGE_MAX)) as ProposalRow[];
  const events = rows.map(toEvent);
  return { schemaVersion: MEMORY_SCHEMA_VERSION, events, next: events.at(-1)?.seq ?? after };
}
