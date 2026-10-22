/**
 * M3 S3 boot and periodic sweep of per-run profiles (plans/m3-provisioning.md §3 S3).
 *
 * A session disposes its own profile when it ends. A crash skips that, so after boot or periodic lease
 * recovery, this removes each profile the plane owns whose session is no
 * longer live: terminal, or gone from the database. A live session keeps its profile (a K11
 * continuation or resume provisions again under its own session, with the same digest).
 *
 * Ownership is the profile's marker, never the directory name: an entry without a marker naming
 * this session, a symlink or a plain file is reported and left alone. A half-written profile
 * (`<sessionId>.staging-<uuid>`) is swept only when its marker was already written.
 */
import { lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ExecutionSessionState, NormalizedEvent, ProvisioningSweptPayload } from "@agent-plane/core";
import { isSessionTerminal } from "@agent-plane/core";
import { assertProfileRoot, PROFILE_MARKER } from "@agent-plane/adapters";

const STAGING = /^(.+)\.staging-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ProfileSweepDeps {
  /** `<plane dir>/profiles`. */
  root: string;
  /** The session's state, or undefined when no such session exists. */
  sessionState(sessionId: string): ExecutionSessionState | undefined;
  /** Append to a session that has settled (`EventRecorder.appendSettled`). */
  record(sessionId: string, events: NormalizedEvent[]): void;
  now?: () => Date;
}

export interface ProfileSweepResult {
  /** Entries removed, by name. */
  removed: string[];
  /** Profiles of live sessions, kept. */
  retained: string[];
  /** Entries the plane cannot prove it owns, left in place. */
  unowned: string[];
}

interface Marker { owner?: unknown; sessionId?: unknown; compositionRevisionId?: unknown; profileDigest?: unknown }

function ownedMarker(dir: string, sessionId: string): { compositionRevisionId: string; profileDigest: string } | undefined {
  try {
    const path = join(dir, PROFILE_MARKER);
    if (!lstatSync(path).isFile()) return undefined;
    const m = JSON.parse(readFileSync(path, "utf8")) as Marker;
    if (m.owner !== "agent-plane" || m.sessionId !== sessionId) return undefined;
    if (typeof m.compositionRevisionId !== "string" || typeof m.profileDigest !== "string") return undefined;
    return { compositionRevisionId: m.compositionRevisionId, profileDigest: m.profileDigest };
  } catch {
    return undefined;
  }
}

export function sweepProfiles(deps: ProfileSweepDeps): ProfileSweepResult {
  const result: ProfileSweepResult = { removed: [], retained: [], unowned: [] };
  let names: string[];
  try {
    names = readdirSync(deps.root).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return result;
    throw err;
  }
  for (const name of names) {
    const path = join(deps.root, name);
    const staging = STAGING.exec(name);
    const sessionId = staging ? staging[1]! : name;
    let marker: ReturnType<typeof ownedMarker>;
    try {
      assertProfileRoot(path);
      const st = lstatSync(path);
      marker = st.isDirectory() && !st.isSymbolicLink() ? ownedMarker(path, sessionId) : undefined;
    } catch {
      marker = undefined;
    }
    if (!marker) {
      result.unowned.push(name);
      continue;
    }
    // This check and removal are synchronous. STARTING/RUNNING are non-terminal, so a live
    // runner keeps its profile, including a marked staging directory during provisioning.
    const state = deps.sessionState(sessionId);
    if (state !== undefined && !isSessionTerminal(state)) {
      result.retained.push(name);
      continue;
    }
    rmSync(path, { recursive: true, force: true });
    result.removed.push(name);
    if (state === undefined) continue; // no session row to attach the witness to
    const payload: ProvisioningSweptPayload = { ...marker, staging: !!staging };
    deps.record(sessionId, [{
      runId: sessionId as never,
      ts: (deps.now ? deps.now() : new Date()).toISOString(),
      type: "provisioning.swept",
      summary: `profile sweep removed ${staging ? "half-written " : ""}profile ${marker.profileDigest} left by a ${state} session`,
      payload: { ...payload },
    }]);
  }
  return result;
}
