import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  SessionInputRejectedError,
  SessionInputUnresolvedError,
  type SessionInputAdapter,
  type SessionInputAvailability,
  type SessionInputCapabilities,
  type SessionInputMessage,
  type SessionInputReceipt,
  type SessionInputTarget,
} from "@agent-plane/core";

/**
 * The live stdin half of one Claude Code CLI run, as `ClaudeAdapter` exposes it.
 * `alive()` is the only liveness claim this adapter trusts from inside the
 * process; anything about a run we do not own is established from the CLI's own
 * artefacts instead.
 */
export interface ClaudeLiveSession {
  providerSessionRef: string;
  cwd: string;
  alive(): boolean;
  push(uuid: string, text: string): void;
}

/** Resolves the live run for an Agentic OS session id (which IS the run id). */
export type ClaudeLiveSessionLookup = (sessionId: string) => ClaudeLiveSession | undefined;

export interface ClaudeSessionInputOptions {
  /**
   * How long `deliver` waits for the CLI to fold the message into its
   * transcript before giving up and reporting an UNKNOWN outcome. Bounded on
   * purpose: a turn can run for minutes and an HTTP request must not.
   */
  ackTimeoutMs?: number;
  /** How long `lookupReceipt` waits on a still-live process before answering. */
  reconcileGraceMs?: number;
  pollIntervalMs?: number;
  /** Override for tests. Defaults to `$CLAUDE_CONFIG_DIR/projects` or `~/.claude/projects`. */
  projectsDir?: string;
  /** Override for tests: is a CLI process for this session still running? */
  processAlive?: (providerSessionRef: string) => boolean;
}

/** Fixed namespace so one server message always derives ONE transcript uuid. */
const UUID_NAMESPACE = "agentic-os/session-input";

/**
 * Live Claude Code CLI session-input adapter — the first real implementation of
 * `SessionInputAdapter`, alongside (never replacing) `FakeSessionInputAdapter`.
 *
 * ## What counts as proof of delivery
 *
 * Pushing bytes into the CLI's stdin proves nothing: the write returning means
 * the pipe accepted it, not that the agent did. The CLI's own answer is its
 * session transcript — `~/.claude/projects/<slug>/<session-id>.jsonl` — into
 * which it writes, at the moment it FOLDS the message into a turn, one line
 * stamped with the uuid the caller supplied: a `type: "user"` line when the
 * message became its own turn, or a `queued_command` attachment whose
 * `source_uuid` is that uuid when it was pushed into a turn already running.
 * That line is written BY the provider, ABOUT our message id, and it outlives
 * both our process and the CLI's. Nothing weaker is treated as delivery here:
 *
 * | Evidence | Claim |
 * | --- | --- |
 * | `push()` returned | transport only — never `delivered` |
 * | CLI enqueued it (`queue-operation`) | not used: written before the fold |
 * | transcript carries our uuid | `provider-accepted` — the receipt |
 * | assistant text afterwards | NOT claimed (see below) |
 *
 * `provider-consumed` is deliberately not claimable: the CLI's assistant
 * frames do not root their `parentUuid` chain at the delivered user message,
 * and several queued messages coalesce into one turn, so no assistant output
 * can be honestly attributed to one input id. Claiming it would be exactly the
 * "an assistant response alone is not a reliable input receipt" failure the
 * contract names.
 *
 * ## Why `idempotentSend` is false here and true for the fake
 *
 * The fake adapter dedupes on message id, so an ambiguous outcome can be
 * resolved by simply sending again. The real CLI does not: a second push of
 * the same uuid appends a second user turn. Ambiguity therefore has exactly
 * one safe resolution — read the transcript — which is why this adapter
 * declares `receiptLookup` and refuses to guess.
 */
export class ClaudeCodeSessionInputAdapter implements SessionInputAdapter {
  private ackTimeoutMs: number;
  private reconcileGraceMs: number;
  private pollIntervalMs: number;
  private projectsDir: string;
  private processAlive: (ref: string) => boolean;

  constructor(
    private lookup: ClaudeLiveSessionLookup,
    options: ClaudeSessionInputOptions = {},
  ) {
    this.ackTimeoutMs = options.ackTimeoutMs ?? 15_000;
    this.reconcileGraceMs = options.reconcileGraceMs ?? 5_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.projectsDir = options.projectsDir ?? defaultProjectsDir();
    this.processAlive = options.processAlive ?? claudeProcessAlive;
  }

  capabilities(): SessionInputCapabilities {
    return {
      capabilityVersion: "claude-code-session-input/1",
      kinds: ["text"],
      // The transcript line is the CLI's own record that it took the message.
      ackLevel: "provider-accepted",
      // The CLI does NOT deduplicate a repeated uuid: a blind re-send is a
      // second user turn. Ambiguity is resolved by lookup, never by replay.
      idempotentSend: false,
      receiptLookup: true,
      liveDelivery: ["running", "waiting-input"],
    };
  }

  /**
   * Truthful per-session availability. A Claude assistant with no live run has
   * NO session-input capability, and says so — the manifest never reports the
   * provider as reachable just because the assistant is configured.
   */
  async probeTarget(target: SessionInputTarget): Promise<SessionInputAvailability> {
    const live = this.lookup(target.sessionId);
    if (!live || !live.alive()) return { available: false, reason: "no_live_provider_session" };
    if (target.providerSessionRef && target.providerSessionRef !== live.providerSessionRef) {
      return { available: false, reason: "provider_session_mismatch" };
    }
    return { available: true, providerSessionRef: live.providerSessionRef };
  }

  async deliver(target: SessionInputTarget, message: SessionInputMessage): Promise<SessionInputReceipt> {
    const live = this.live(target);
    const uuid = transcriptUuid(message.messageId);
    live.push(uuid, message.text);
    // Bounded wait for the CLI's own record. A timeout is an UNKNOWN outcome,
    // not a failure: the message may still be sitting in the CLI's queue behind
    // a long turn, and calling that "not delivered" would be a false audit.
    const receipt = await this.awaitTranscript(live.providerSessionRef, live.cwd, message.messageId, uuid, () => live.alive(), this.ackTimeoutMs);
    if (receipt) return receipt;
    if (!live.alive()) {
      // The session ended without ever folding it, and a dead CLI cannot fold
      // anything later: this one is definitively undelivered.
      throw new SessionInputRejectedError("provider_session_ended_undelivered");
    }
    throw new Error(`no transcript acknowledgement within ${this.ackTimeoutMs}ms`);
  }

  /**
   * Reconciliation against the real process.
   *
   * `null` is a strong claim in this contract — the caller re-sends on it — so
   * it is returned ONLY when nothing can still arrive: the uuid is absent AND
   * no CLI process for this session is running. While a process is alive the
   * message may yet be folded, so the answer is "unresolved", which leaves the
   * ledger unknown instead of authorising a second delivery.
   */
  async lookupReceipt(target: SessionInputTarget, messageId: string): Promise<SessionInputReceipt | null> {
    const ref = target.providerSessionRef ?? this.lookup(target.sessionId)?.providerSessionRef;
    if (!ref) return null; // never started: nothing was ever pushed anywhere
    const live = this.lookup(target.sessionId);
    if (live && target.providerSessionRef && live.providerSessionRef !== target.providerSessionRef) {
      throw new SessionInputRejectedError("provider_session_mismatch");
    }
    const cwd = live?.cwd;
    const uuid = transcriptUuid(messageId);
    const alive = () => (live ? live.alive() : this.processAlive(ref));
    const found = await this.awaitTranscript(ref, cwd, messageId, uuid, alive, alive() ? this.reconcileGraceMs : 0);
    if (found) return found;
    if (alive()) throw new SessionInputUnresolvedError("provider_session_still_live");
    return null;
  }

  /** Polls the CLI's transcript until the uuid lands, the process dies, or time runs out. */
  private async awaitTranscript(
    ref: string,
    cwd: string | undefined,
    messageId: string,
    uuid: string,
    alive: () => boolean,
    budgetMs: number,
  ): Promise<SessionInputReceipt | null> {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const at = this.scanTranscript(ref, cwd, uuid);
      if (at) {
        return { messageId, reference: `transcript:${ref}#${uuid}`, ackLevel: "provider-accepted", at };
      }
      // One last read AFTER the process is gone: a CLI can fold a queued
      // message on its way out, and the file is the arbiter, not our timing.
      if (!alive()) {
        const final = this.scanTranscript(ref, cwd, uuid);
        return final ? { messageId, reference: `transcript:${ref}#${uuid}`, ackLevel: "provider-accepted", at: final } : null;
      }
      if (Date.now() >= deadline) return null;
      await delay(Math.min(this.pollIntervalMs, Math.max(0, deadline - Date.now())));
    }
  }

  /**
   * Reads ONE session's transcript and returns the timestamp of our uuid.
   *
   * Isolation lives here: the file is addressed by the provider session ref the
   * kernel recorded for this session, and a line only counts when its own
   * `sessionId` matches that ref and its `cwd` matches the workspace directory
   * the run was launched in. A transcript belonging to another workspace can
   * therefore never answer for this session, even if a uuid collided.
   */
  private scanTranscript(ref: string, cwd: string | undefined, uuid: string): string | null {
    const file = this.transcriptPath(ref);
    if (!file) return null;
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return null;
    }
    // Cheap reject before parsing: transcripts grow large and most scans miss.
    if (!text.includes(uuid)) return null;
    for (const line of text.split("\n")) {
      if (!line.includes(uuid)) continue;
      let entry: TranscriptEntry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // a torn last line while the CLI is writing
      }
      // Two shapes, both written by the CLI and both carrying our uuid:
      //
      // - `type: "user"` with our uuid, when the message became its own turn;
      // - `type: "attachment"` with `attachment.type: "queued_command"` and
      //   `source_uuid` = our uuid, when the message was pushed DURING a turn
      //   and folded into it. This is the normal case for session-addressed
      //   input, and it was only visible against a real CLI.
      const mine =
        (entry.type === "user" && entry.uuid === uuid) ||
        (entry.type === "attachment" &&
          entry.attachment?.type === "queued_command" &&
          entry.attachment.source_uuid === uuid);
      if (!mine) continue;
      if (entry.sessionId !== ref) continue;
      if (cwd && entry.cwd && entry.cwd !== cwd) continue;
      return entry.timestamp ?? new Date().toISOString();
    }
    return null;
  }

  /** `<projects>/<slug>/<ref>.jsonl`, found by ref rather than by re-deriving the slug. */
  private transcriptPath(ref: string): string | null {
    let slugs: string[];
    try {
      slugs = readdirSync(this.projectsDir);
    } catch {
      return null;
    }
    for (const slug of slugs) {
      const file = join(this.projectsDir, slug, `${ref}.jsonl`);
      if (existsSync(file)) return file;
    }
    return null;
  }

  private live(target: SessionInputTarget): ClaudeLiveSession {
    const live = this.lookup(target.sessionId);
    if (!live || !live.alive()) {
      // Truthful refusal, not an eternal queue: this session has no process to
      // deliver to and the record says exactly that.
      throw new SessionInputRejectedError("provider_session_unavailable");
    }
    if (target.providerSessionRef && target.providerSessionRef !== live.providerSessionRef) {
      // The kernel's record and the live process disagree about which provider
      // session this is. Pushing anyway would write into someone else's run.
      throw new SessionInputRejectedError("provider_session_mismatch");
    }
    return live;
  }
}

/** Stable uuid for a server message id: the same message always has one identity. */
export function transcriptUuid(messageId: string): string {
  const h = createHash("sha1").update(`${UUID_NAMESPACE}:${messageId}`).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x50; // version 5
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function defaultProjectsDir(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
}

/**
 * Is a Claude Code CLI still running for this session? The session id is on the
 * process command line because live-input runs mint it themselves, so this is a
 * direct observation rather than a guess about our own bookkeeping.
 */
function claudeProcessAlive(ref: string): boolean {
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((e) => /^\d+$/.test(e));
  } catch {
    return false; // no procfs: fall back to "nothing is running"
  }
  for (const pid of pids) {
    try {
      if (readFileSync(join("/proc", pid, "cmdline"), "utf8").includes(ref)) return true;
    } catch {
      continue; // the process exited between listing and reading
    }
  }
  return false;
}

interface TranscriptEntry {
  type?: string;
  uuid?: string;
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  attachment?: { type?: string; source_uuid?: string };
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
