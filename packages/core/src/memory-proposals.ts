/**
 * O6 S5 memory proposals (docs/agentic-os-o6-memory-writeback.md §2.3, Q2, Q4; contract
 * docs/contracts/memory-v1.md). For one settled, composed session: parse the fenced
 * `agent-plane-memory` block the agent wrote in its last message into candidate memories, and drop
 * (never redact) every entry that is malformed or trips a content guard, counting why.
 *
 * Pure, under the Composer's purity lint rule: no clock, environment, locale or I/O. Hashing and
 * the contract's content guards are injected, so the api's reference guards are the only guards.
 * Every input is final once the session is terminal, so a re-derivation is byte-equal.
 *
 * Nothing here writes memory. A proposal is a candidate the operator accepts or rejects in Cockpit.
 */

import { jcs } from "./canonical-json.js";
import type { ReliabilityClass } from "./execution.js";
import { REDACTED } from "./redaction.js";

export const MEMORY_PROPOSAL_FENCE = "agent-plane-memory";
/** Plan §2.3: at most 5 entries per block; the rest are counted as truncated. */
export const MEMORY_PROPOSAL_MAX_ENTRIES = 5;
export const MEMORY_PROPOSAL_PARSER_VERSION = 1;
const BODY_MAX_BYTES = 4096;
const DESCRIPTION_MAX = 300;
const NAME_MAX = 64;
const SUPERSEDES_MAX = 16;

export type MemoryProposalKind = "decision" | "gotcha" | "fact";
export type MemoryProposalHarness = "claude-code" | "codex" | "cursor" | "bedrock";
/** Guards the memory v1 contract defines (`memoryProposalGuardHits`), as the api classifies its hits. */
export type MemoryProposalGuard = "credential" | "absolute_path" | "hostname";

export type MemoryProposalDropReason =
  | "malformed_block"
  | "not_an_object"
  | "unknown_field"
  | "bad_kind"
  | "bad_name"
  | "bad_description"
  | "bad_body"
  | "body_too_large"
  | "bad_target"
  | "bad_supersedes"
  | "redacted"
  | `guard_${MemoryProposalGuard}`;

export type MemoryProposalSkipReason = "not_completion" | "not_success" | "ambient" | "no_block";

export interface MemoryProposalDeps {
  /** 64 lowercase hex characters of sha256 over the UTF-8 text. */
  sha256(text: string): string;
  /** The contract guards the entry's text trips, each at most once. */
  guardHits(entry: { name: string; description: string; body: string }): MemoryProposalGuard[];
}

export interface MemoryProposalInput {
  sessionId: string;
  taskId: string;
  compositionRevisionId: string;
  harness: MemoryProposalHarness;
  /** The session's resolved model, or null. A value outside the contract's pattern becomes null. */
  model: string | null;
  /** The settled result's reliability class (Q4: only `success` proposes). */
  outcome: ReliabilityClass;
  /** True when the session had no verified isolated profile (ambient). */
  ambient: boolean;
  /** The checkpoint the settled result names, if it is that session's `completion` checkpoint. */
  checkpoint: { id: string; at: string; reason: string } | null;
  verificationPassed: boolean | null;
  changedFiles: number;
  /** The revision's `context.memory_bundles` pins. */
  pinnedBundles: ReadonlyArray<{ id: string; digest: string }>;
  /** The text of the session's last `message` event (already redacted at persistence), or null. */
  lastMessage: string | null;
}

/** One proposal, the memory v1 event without the plane-assigned `seq` and `schemaVersion`. */
export interface MemoryProposal {
  proposalId: string;
  index: number;
  sessionId: string;
  taskId: string;
  compositionRevisionId: string;
  checkpointId: string;
  harness: MemoryProposalHarness;
  model: string | null;
  kind: MemoryProposalKind;
  name: string;
  description: string;
  body: string;
  target: { bundleId: string; bundleDigest: string } | null;
  supersedes: string[];
  evidence: { outcome: "success"; verificationPassed: boolean | null; changedFiles: number };
  at: string;
  /** `sha256:` over the JCS of every field above except `proposalId`: the conflict comparison. */
  bodyDigest: string;
}

export interface MemoryProposalDerivation {
  status: "proposed" | "skipped";
  skipReason?: MemoryProposalSkipReason;
  proposals: MemoryProposal[];
  /** Entries dropped, by reason. A malformed block counts once. */
  dropped: Partial<Record<MemoryProposalDropReason, number>>;
  /** Entries past {@link MEMORY_PROPOSAL_MAX_ENTRIES}, never read. */
  truncated: number;
  /** Entries kept with `target: null` because they named a bundle the revision did not pin. */
  untargeted: number;
  parserVersion: number;
}

const HEX64 = /^[0-9a-f]{64}$/;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,127}$/;
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// A memory file relative to the bundle's memory/ dir: no leading slash, no . or .. segment, no backslash or NUL.
// eslint-disable-next-line no-control-regex -- NUL is exactly what the contract refuses
const MEMBER_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\u0000\\]+\.md$/;
const ENTRY_KEYS = new Set(["kind", "name", "description", "body", "targetBundle", "supersedes"]);
const KINDS = new Set<string>(["decision", "gotcha", "fact"]);
// The last fenced block of this language in the message: an opening fence on its own line, a closing one on its own line.
const FENCE = new RegExp(`^\`\`\`${MEMORY_PROPOSAL_FENCE}[ \\t]*\\r?\\n([\\s\\S]*?)^\`\`\`[ \\t]*$`, "gm");

function hex(deps: MemoryProposalDeps, text: string): string {
  const h = deps.sha256(text);
  if (!HEX64.test(h)) throw new Error("memory proposals: deps.sha256 must return 64 lowercase hex characters");
  return h;
}

/** UTF-8 byte length without Buffer or TextEncoder (pure). Lone surrogates count as U+FFFD (3 bytes). */
export function utf8Length(text: string): number {
  let n = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}

/** UTF-8 byte order is code point order. */
function byCodePoint(a: string, b: string): number {
  const x = [...a], y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/** `"mp1_" + hex sha256(JCS({v: 1, sessionId, index, bodyDigest}))`: the memory v1 proposal id. */
export function memoryProposalId(sessionId: string, index: number, body: string, deps: Pick<MemoryProposalDeps, "sha256">): string {
  const bodyDigest = `sha256:${hex(deps as MemoryProposalDeps, body)}`;
  return `mp1_${hex(deps as MemoryProposalDeps, jcs({ v: 1, sessionId, index, bodyDigest }, "integer"))}`;
}

/** The JSON text of the last `agent-plane-memory` block in `message`, or undefined when there is none. */
export function lastMemoryBlock(message: string): string | undefined {
  let last: string | undefined;
  for (const m of message.matchAll(FENCE)) last = m[1];
  return last;
}

const record = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

type Entry = Pick<MemoryProposal, "kind" | "name" | "description" | "body" | "supersedes"> & { targetBundle: string | null };

/** Shape checks for one block entry. Returns the reason it is dropped, or the entry. */
function readEntry(raw: unknown): Entry | MemoryProposalDropReason {
  const e = record(raw);
  if (!e) return "not_an_object";
  if (Object.keys(e).some((k) => !ENTRY_KEYS.has(k))) return "unknown_field";
  if (typeof e.kind !== "string" || !KINDS.has(e.kind)) return "bad_kind";
  if (typeof e.name !== "string" || e.name.length > NAME_MAX || !NAME.test(e.name)) return "bad_name";
  if (typeof e.description !== "string" || e.description.length < 1 || e.description.length > DESCRIPTION_MAX || /[\r\n]/.test(e.description)) return "bad_description";
  if (typeof e.body !== "string" || e.body.length < 1) return "bad_body";
  if (utf8Length(e.body) > BODY_MAX_BYTES) return "body_too_large";
  if (e.targetBundle !== undefined && e.targetBundle !== null && (typeof e.targetBundle !== "string" || !BUNDLE_ID.test(e.targetBundle))) return "bad_target";
  let supersedes: string[] = [];
  if (e.supersedes !== undefined && e.supersedes !== null) {
    if (!Array.isArray(e.supersedes) || e.supersedes.length > SUPERSEDES_MAX) return "bad_supersedes";
    if (!e.supersedes.every((p): p is string => typeof p === "string" && p.length >= 4 && p.length <= 255 && MEMBER_PATH.test(p))) return "bad_supersedes";
    supersedes = [...new Set(e.supersedes)].sort(byCodePoint);
    if (supersedes.length !== e.supersedes.length) return "bad_supersedes";
  }
  return {
    kind: e.kind as MemoryProposalKind,
    name: e.name,
    description: e.description,
    body: e.body,
    supersedes,
    targetBundle: typeof e.targetBundle === "string" ? e.targetBundle : null,
  };
}

/**
 * Derive one settled session's proposals. Skipped (no proposals, nothing dropped) unless the
 * session settled `success`, had a verified profile, and its result names its own `completion`
 * checkpoint; a session with no block is skipped too. Entry `index` is the position in the block,
 * so a dropped entry does not move a later entry's id.
 */
export function deriveMemoryProposals(input: MemoryProposalInput, deps: MemoryProposalDeps): MemoryProposalDerivation {
  const out: MemoryProposalDerivation = { status: "skipped", proposals: [], dropped: {}, truncated: 0, untargeted: 0, parserVersion: MEMORY_PROPOSAL_PARSER_VERSION };
  const skip = (skipReason: MemoryProposalSkipReason): MemoryProposalDerivation => ({ ...out, skipReason });
  if (!input.checkpoint || input.checkpoint.reason !== "completion") return skip("not_completion");
  if (input.outcome !== "success") return skip("not_success");
  if (input.ambient) return skip("ambient");
  const block = input.lastMessage === null ? undefined : lastMemoryBlock(input.lastMessage);
  if (block === undefined) return skip("no_block");

  const drop = (reason: MemoryProposalDropReason) => { out.dropped[reason] = (out.dropped[reason] ?? 0) + 1; };
  let entries: unknown;
  try { entries = JSON.parse(block); } catch { entries = undefined; }
  if (!Array.isArray(entries)) {
    drop("malformed_block");
    return { ...out, status: "proposed" };
  }
  out.truncated = Math.max(0, entries.length - MEMORY_PROPOSAL_MAX_ENTRIES);

  const pins = new Map(input.pinnedBundles.map((b) => [b.id, b.digest]));
  const model = input.model !== null && MODEL.test(input.model) ? input.model : null;
  const checkpoint = input.checkpoint;
  entries.slice(0, MEMORY_PROPOSAL_MAX_ENTRIES).forEach((raw, index) => {
    const entry = readEntry(raw);
    if (typeof entry === "string") return drop(entry);
    // Redaction at persistence already replaced a secret in the message: a redacted memory is a wrong memory.
    if ([entry.name, entry.description, entry.body].some((t) => t.includes(REDACTED))) return drop("redacted");
    const hit = deps.guardHits(entry);
    if (hit.length) return drop(`guard_${hit[0]!}`);

    const digest = entry.targetBundle === null ? undefined : pins.get(entry.targetBundle);
    if (entry.targetBundle !== null && digest === undefined) out.untargeted += 1;
    const target = digest === undefined ? null : { bundleId: entry.targetBundle!, bundleDigest: digest };
    const body = {
      index,
      sessionId: input.sessionId,
      taskId: input.taskId,
      compositionRevisionId: input.compositionRevisionId,
      checkpointId: checkpoint.id,
      harness: input.harness,
      model,
      kind: entry.kind,
      name: entry.name,
      description: entry.description,
      body: entry.body,
      target,
      // supersedes names members of the target bundle, so it is empty when there is none.
      supersedes: target ? entry.supersedes : [],
      evidence: { outcome: "success" as const, verificationPassed: input.verificationPassed, changedFiles: input.changedFiles },
      at: checkpoint.at,
    };
    out.proposals.push({
      proposalId: memoryProposalId(input.sessionId, index, entry.body, deps),
      ...body,
      bodyDigest: `sha256:${hex(deps, jcs(body, "integer"))}`,
    });
  });
  return { ...out, status: "proposed" };
}
