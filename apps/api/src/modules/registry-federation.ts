/**
 * M4 registry federation: reads Cockpit's registry v1 snapshot and keeps a
 * metadata-only cache of it in the catalog (migration 032), so asset metadata
 * stays queryable while Cockpit is briefly down.
 *
 * Availability semantics (docs/contracts/registry-v1.md):
 * - Every response is validated against the v1 contract; an unknown major or
 *   an invalid body is rejected and changes nothing.
 * - Cockpit down, a 401 or any other failure keeps the last good snapshot and
 *   records a classified reason. The cache turns `stale` once it is older than
 *   `maxCacheAgeHours`. There is no fallback: the plane never scrapes
 *   ~/.claude and never invents assets.
 * - The bearer token is read from its file per sync, held in memory only, and
 *   registered for log redaction. It is never persisted.
 */
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { registerSecret } from "@agent-plane/core";
import type { ResolvedRegistryConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { REGISTRY_VERSION_HEADER, validateSnapshot, type RegistryAsset, type RegistrySnapshot } from "../registry-contract.js";

const SOURCE = "cockpit";
const CHANGE_SOURCE = "cockpit-registry";
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;

export type RegistrySyncReason =
  | "token_file_missing" | "token_file_unsafe" | "unreachable" | "timeout" | "unauthenticated"
  | "http_error" | "payload_too_large" | "unsupported_version" | "invalid_response";

export class RegistrySyncError extends Error {
  constructor(readonly reason: RegistrySyncReason, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
  }
}

/** Same checks Cockpit applies when it writes the file: regular, same uid, no group/world bits. */
export function readRegistryToken(path: string): string {
  // One fd for check and read, so the path cannot be swapped between them. O_NOFOLLOW makes a
  // symlink fail the open (ELOOP); O_NONBLOCK keeps a FIFO from blocking before fstat rejects it.
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    throw new RegistrySyncError(["ENOENT", "ENOTDIR"].includes(code) ? "token_file_missing" : "token_file_unsafe");
  }
  let token: string;
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) throw new RegistrySyncError("token_file_unsafe");
    token = readFileSync(fd, "utf8").trim();
  } finally {
    closeSync(fd);
  }
  if (!token) throw new RegistrySyncError("token_file_unsafe", "empty");
  registerSecret(token);
  return token;
}

/**
 * Reads the body up to `limit` bytes. A declared Content-Length over the limit is refused before
 * any read, and the stream is cancelled as soon as the running byte count passes it, so an
 * oversized body is never buffered whole.
 */
async function readBounded(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => {});
    throw new RegistrySyncError("payload_too_large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let next: Awaited<ReturnType<typeof reader.read>>;
    try { next = await reader.read(); } catch (err) {
      throw new RegistrySyncError((err as Error)?.name === "TimeoutError" ? "timeout" : "unreachable");
    }
    if (next.done) break;
    total += next.value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new RegistrySyncError("payload_too_large");
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

export interface RegistrySnapshotSource { snapshot(): Promise<RegistrySnapshot> }

export class CockpitRegistryClient implements RegistrySnapshotSource {
  constructor(
    private readonly baseUrl: string,
    private readonly tokenPath: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
    private readonly maxBytes = MAX_SNAPSHOT_BYTES,
  ) {}

  async snapshot(): Promise<RegistrySnapshot> {
    const token = readRegistryToken(this.tokenPath);
    let response: Response;
    try {
      response = await this.fetcher(new URL("/api/v1/registry/assets", this.baseUrl), {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
    } catch (err) {
      throw new RegistrySyncError((err as Error)?.name === "TimeoutError" ? "timeout" : "unreachable");
    }
    if (response.status === 401) throw new RegistrySyncError("unauthenticated");
    if (response.status === 413) throw new RegistrySyncError("payload_too_large");
    if (!response.ok) throw new RegistrySyncError("http_error", String(response.status));
    const text = await readBounded(response, this.maxBytes);
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new RegistrySyncError("invalid_response", "not JSON"); }
    const served = response.headers.get(REGISTRY_VERSION_HEADER);
    const result = validateSnapshot(body);
    if (!result.ok) {
      const unsupported = result.errors.some((e) => e.startsWith("unsupported schemaVersion"));
      throw new RegistrySyncError(unsupported ? "unsupported_version" : "invalid_response", result.errors.slice(0, 3).join("; "));
    }
    if (served !== result.value.schemaVersion) throw new RegistrySyncError("invalid_response", "version header does not match body");
    return result.value;
  }
}

export interface RegistryView {
  enabled: boolean;
  source: string;
  schemaVersion: string | null;
  snapshotDigest: string | null;
  observedAt: string | null;
  stale: boolean;
  maxCacheAgeHours: number;
  lastAttemptAt: string | null;
  lastFailure: string | null;
  assets: RegistryAsset[];
}

export type RegistrySyncResult =
  | { ok: true; snapshotDigest: string; changes: number }
  | { ok: false; reason: RegistrySyncReason | "disabled" };

interface Logger { warn(obj: object, msg: string): void; info?(obj: object, msg: string): void }

interface SnapshotRow { id: number; snapshot_digest: string; schema_version: string; observed_at: string }

export class RegistryFederation {
  constructor(
    private readonly db: Db,
    private readonly config: ResolvedRegistryConfig["cockpit"],
    private readonly source: RegistrySnapshotSource = new CockpitRegistryClient(config.baseUrl, config.tokenPath),
    private readonly now: () => Date = () => new Date(),
    private readonly logger?: Logger,
  ) {}

  async sync(): Promise<RegistrySyncResult> {
    if (!this.config.enabled) return { ok: false, reason: "disabled" };
    const at = this.now().toISOString();
    let snapshot: RegistrySnapshot;
    try {
      snapshot = await this.source.snapshot();
    } catch (err) {
      const reason = err instanceof RegistrySyncError ? err.reason : "unreachable";
      this.recordAttempt(at, reason);
      this.logger?.warn({ source: SOURCE, reason, stale: this.read().stale }, "registry sync failed; keeping last snapshot");
      return { ok: false, reason };
    }
    const changes = this.store(snapshot, at);
    this.recordAttempt(at, null);
    return { ok: true, snapshotDigest: snapshot.snapshotDigest, changes };
  }

  private latest(): SnapshotRow | undefined {
    return this.db.prepare(
      "SELECT id, snapshot_digest, schema_version, observed_at FROM registry_snapshots WHERE source = ? ORDER BY observed_at DESC, id DESC LIMIT 1",
    ).get(SOURCE) as SnapshotRow | undefined;
  }

  private members(snapshotId: number): Map<string, string> {
    const rows = this.db.prepare("SELECT asset_id, digest FROM registry_snapshot_assets WHERE snapshot_id = ?").all(snapshotId) as Array<{ asset_id: string; digest: string }>;
    return new Map(rows.map((r) => [r.asset_id, r.digest]));
  }

  /** Writes the snapshot and its change rows in one transaction; returns the number of change rows. */
  private store(snapshot: RegistrySnapshot, at: string): number {
    return this.db.transaction(() => {
      const previous = this.latest();
      const before = previous ? this.members(previous.id) : undefined;
      const insertAsset = this.db.prepare(
        "INSERT OR IGNORE INTO registry_assets (asset_id, digest, kind, metadata, first_seen_at) VALUES (?, ?, ?, ?, ?)",
      );
      for (const asset of snapshot.assets) insertAsset.run(asset.id, asset.digest, asset.kind, JSON.stringify(asset), at);
      this.db.prepare(
        `INSERT INTO registry_snapshots (source, snapshot_digest, schema_version, asset_count, first_seen_at, observed_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (source, snapshot_digest) DO UPDATE SET observed_at = excluded.observed_at, schema_version = excluded.schema_version`,
      ).run(SOURCE, snapshot.snapshotDigest, snapshot.schemaVersion, snapshot.assets.length, at, at);
      const { id } = this.db.prepare("SELECT id FROM registry_snapshots WHERE source = ? AND snapshot_digest = ?").get(SOURCE, snapshot.snapshotDigest) as { id: number };
      this.db.prepare("DELETE FROM registry_snapshot_assets WHERE snapshot_id = ?").run(id);
      const member = this.db.prepare("INSERT INTO registry_snapshot_assets (snapshot_id, asset_id, digest) VALUES (?, ?, ?)");
      for (const asset of snapshot.assets) member.run(id, asset.id, asset.digest);

      // The first observation is a baseline, not a change (as for capability_changes).
      if (!before || previous!.snapshot_digest === snapshot.snapshotDigest) return 0;
      const change = this.db.prepare(
        `INSERT INTO registry_asset_changes (asset_id, change, old_digest, new_digest, snapshot_digest, source, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      let count = 0;
      const after = new Map(snapshot.assets.map((a) => [a.id, a.digest]));
      for (const [assetId, digest] of after) {
        const old = before.get(assetId);
        if (old === undefined) { change.run(assetId, "added", null, digest, snapshot.snapshotDigest, CHANGE_SOURCE, at); count++; }
        else if (old !== digest) { change.run(assetId, "digest_changed", old, digest, snapshot.snapshotDigest, CHANGE_SOURCE, at); count++; }
      }
      for (const [assetId, digest] of before) {
        if (!after.has(assetId)) { change.run(assetId, "removed", digest, null, snapshot.snapshotDigest, CHANGE_SOURCE, at); count++; }
      }
      return count;
    })();
  }

  private recordAttempt(at: string, failure: string | null): void {
    this.db.prepare(
      `INSERT INTO registry_sync_state (source, last_attempt_at, last_success_at, last_failure) VALUES (?, ?, ?, ?)
       ON CONFLICT (source) DO UPDATE SET last_attempt_at = excluded.last_attempt_at,
         last_success_at = COALESCE(excluded.last_success_at, registry_sync_state.last_success_at),
         last_failure = excluded.last_failure`,
    ).run(SOURCE, at, failure ? null : at, failure);
  }

  read(): RegistryView {
    const snap = this.latest();
    const state = this.db.prepare("SELECT last_attempt_at, last_failure FROM registry_sync_state WHERE source = ?").get(SOURCE) as
      | { last_attempt_at: string; last_failure: string | null } | undefined;
    const assets = snap
      ? (this.db.prepare(
          `SELECT a.metadata FROM registry_snapshot_assets m
           JOIN registry_assets a ON a.asset_id = m.asset_id AND a.digest = m.digest
           WHERE m.snapshot_id = ? ORDER BY m.asset_id`,
        ).all(snap.id) as Array<{ metadata: string }>).map((r) => JSON.parse(r.metadata) as RegistryAsset)
      : [];
    const ageMs = snap ? this.now().getTime() - Date.parse(snap.observed_at) : Infinity;
    return {
      enabled: this.config.enabled,
      source: SOURCE,
      schemaVersion: snap?.schema_version ?? null,
      snapshotDigest: snap?.snapshot_digest ?? null,
      observedAt: snap?.observed_at ?? null,
      stale: ageMs > this.config.maxCacheAgeHours * 3_600_000,
      maxCacheAgeHours: this.config.maxCacheAgeHours,
      lastAttemptAt: state?.last_attempt_at ?? null,
      lastFailure: state?.last_failure ?? null,
      assets,
    };
  }

  recentChanges(limit = 50): unknown[] {
    return this.db.prepare(
      "SELECT asset_id, change, old_digest, new_digest, snapshot_digest, source, observed_at FROM registry_asset_changes ORDER BY id DESC LIMIT ?",
    ).all(limit);
  }
}
