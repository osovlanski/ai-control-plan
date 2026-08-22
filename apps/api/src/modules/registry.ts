import type { AgentAdapter, AssistantId, CapabilityManifest } from "@agent-plane/core";
import {
  BedrockAdapter,
  ClaudeAdapter,
  CodexAdapter,
  CursorAdapter,
  FakeAdapter,
  type BedrockOptions,
  type CursorOptions,
} from "@agent-plane/adapters";
import type { ResolvedConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { probeCapability, type CapabilityProbe } from "./capability-probe.js";

export interface AssistantRow {
  id: string;
  provider: string;
  tier: number;
  enabled: number;
  manifest: string | null;
  manifest_updated_at: string | null;
}

/**
 * Assistant registry: seeds instances from workspace config, holds the
 * adapter for each, and caches capability manifests (synced on demand and
 * daily from Phase 3). Manifest diffs land in capability_changes.
 */
export class Registry {
  private adapters = new Map<string, AgentAdapter>();

  constructor(
    private db: Db,
    private config: ResolvedConfig,
    private capabilityProbe: CapabilityProbe = probeCapability,
  ) {}

  /** Seed assistants table + adapter instances from config. Call at boot. */
  init(): void {
    const upsert = this.db.prepare(
      `INSERT INTO assistants (id, provider, enabled) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, enabled = excluded.enabled`,
    );
    for (const [id, cfg] of Object.entries(this.config.assistants)) {
      this.adapters.set(id, createAdapter(id as AssistantId, cfg.provider, cfg.options ?? {}));
      upsert.run(id, cfg.provider, cfg.enabled === false ? 0 : 1);
    }
    // Config removals: disable rows for assistants no longer configured.
    const known = Object.keys(this.config.assistants);
    if (known.length > 0) {
      this.db
        .prepare(
          `UPDATE assistants SET enabled = 0 WHERE id NOT IN (${known.map(() => "?").join(",")})`,
        )
        .run(...known);
    }
  }

  adapter(id: string): AgentAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`Unknown assistant: ${id}`);
    return adapter;
  }

  list(): Array<AssistantRow & { manifestParsed: CapabilityManifest | null }> {
    const rows = this.db
      .prepare("SELECT id, provider, tier, enabled, manifest, manifest_updated_at FROM assistants ORDER BY id")
      .all() as AssistantRow[];
    return rows.map((r) => ({
      ...r,
      manifestParsed: r.manifest ? (JSON.parse(r.manifest) as CapabilityManifest) : null,
    }));
  }

  manifest(id: string): CapabilityManifest | null {
    const row = this.db.prepare("SELECT manifest FROM assistants WHERE id = ?").get(id) as
      | { manifest: string | null }
      | undefined;
    return row?.manifest ? (JSON.parse(row.manifest) as CapabilityManifest) : null;
  }

  /** Calls adapter.describe(), diffs against the cached manifest, records changes. */
  async sync(id: string): Promise<CapabilityManifest> {
    const adapter = this.adapter(id);
    const next = await adapter.describe();
    const prev = this.manifest(id);
    const now = new Date().toISOString();

    if (prev) {
      const insertChange = this.db.prepare(
        `INSERT INTO capability_changes (assistant_id, field, old_value, new_value, source, observed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const change of diffManifests(prev, next)) {
        insertChange.run(id, change.field, change.oldValue, change.newValue, next.evidence.source, now);
      }
    }

    this.db
      .prepare("UPDATE assistants SET manifest = ?, manifest_updated_at = ? WHERE id = ?")
      .run(JSON.stringify(next), now, id);
    return next;
  }

  async syncAll(): Promise<void> {
    for (const id of this.adapters.keys()) {
      try {
        await this.sync(id);
      } catch {
        // A failing probe must not block boot; the assistant simply has no manifest yet.
      }
    }
  }

  async syncChanged(id: string): Promise<{ changed: boolean; manifest: CapabilityManifest | null }> {
    const provider = this.config.assistants[id]?.provider;
    if (!provider) throw new Error(`Unknown assistant: ${id}`);
    const probe = await this.capabilityProbe(provider);
    const previous = this.db.prepare("SELECT fingerprint,details FROM capability_probes WHERE assistant_id=?").get(id) as { fingerprint: string; details: string } | undefined;
    const previousDetails = previous ? JSON.parse(previous.details) as Record<string, unknown> : undefined;
    const changed = !previous || previous.fingerprint !== probe.fingerprint || !this.manifest(id);
    let manifest = this.manifest(id);
    if (changed) {
      // describe() IS the runtime probe and outranks anything scraped from local
      // config (evidence priority, review §3.4). The cheap probe only decides
      // WHETHER to re-describe; it must never author core manifest values, or a
      // config-file guess silently overrides the adapter's own answer — which
      // once marked env-authenticated assistants "auth missing" and made the
      // router filter them out entirely.
      manifest = await this.sync(id);
      manifest.providerDetail = { ...manifest.providerDetail, version: probe.version, configHash: probe.configHash };
      this.db.prepare("UPDATE assistants SET manifest=? WHERE id=?").run(JSON.stringify(manifest), id);
    }
    const now = new Date().toISOString();
    if (previousDetails) {
      // Only what the probe uniquely knows. Manifest-level changes (models,
      // auth, capabilities) are already diffed and recorded by sync().
      const insertChange = this.db.prepare("INSERT INTO capability_changes (assistant_id,field,old_value,new_value,source,observed_at) VALUES (?,?,?,?, 'runtime-probe',?)");
      for (const [field, value] of Object.entries({ "provider.version": probe.version, "provider.configHash": probe.configHash })) {
        const oldValue = field === "provider.configHash" ? previousDetails.configHash : previousDetails.version;
        if (String(oldValue ?? "") !== String(value)) insertChange.run(id, field, String(oldValue ?? ""), String(value), now);
      }
    }
    this.db.prepare(`INSERT INTO capability_probes (assistant_id,fingerprint,details,observed_at) VALUES (?,?,?,?)
      ON CONFLICT(assistant_id) DO UPDATE SET fingerprint=excluded.fingerprint,details=excluded.details,observed_at=excluded.observed_at`)
      .run(id, probe.fingerprint, JSON.stringify(probe), now);
    const insert = this.db.prepare("INSERT INTO quota_snapshots (assistant_id,window,used_percent,resets_at,source,observed_at) VALUES (?,?,?,?,?,?)");
    for (const limit of manifest?.core.limits ?? []) insert.run(id, limit.window, limit.usedPercent, limit.resetsAt ?? null, limit.source, limit.observedAt);
    return { changed, manifest };
  }

  /**
   * One unavailable provider must not block the others, but a permanently
   * failing probe must not be invisible either — failures are returned so the
   * caller can log them rather than swallowed here.
   */
  async syncChangedAll(): Promise<{ synced: number; failed: Array<{ id: string; error: string }> }> {
    const failed: Array<{ id: string; error: string }> = [];
    let synced = 0;
    for (const id of this.adapters.keys()) {
      try {
        await this.syncChanged(id);
        synced += 1;
      } catch (err) {
        failed.push({ id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { synced, failed };
  }

  recentChanges(limit = 50): unknown[] {
    return this.db
      .prepare(
        "SELECT assistant_id, field, old_value, new_value, source, observed_at FROM capability_changes ORDER BY id DESC LIMIT ?",
      )
      .all(limit);
  }
}

function createAdapter(
  id: AssistantId,
  provider: string,
  options: Record<string, unknown> = {},
): AgentAdapter {
  switch (provider) {
    case "anthropic":
      return new ClaudeAdapter(id);
    case "openai":
      return new CodexAdapter(id);
    case "cursor":
      return new CursorAdapter(id, options as CursorOptions);
    case "bedrock":
      // Bedrock hosts YOUR agent: the runtime ARN is configuration, not
      // something the plane can discover (review §2.4).
      return new BedrockAdapter(id, options as BedrockOptions);
    case "fake":
      return new FakeAdapter(id);
    default:
      throw new Error(
        `Unsupported provider "${provider}" for assistant ${id} (supported: anthropic, openai, cursor, bedrock, fake)`,
      );
  }
}

/** Flat diff over the routing-relevant core fields (provider bag changes are cosmetic for now). */
function diffManifests(
  prev: CapabilityManifest,
  next: CapabilityManifest,
): Array<{ field: string; oldValue: string; newValue: string }> {
  const changes: Array<{ field: string; oldValue: string; newValue: string }> = [];
  const flatten = (m: CapabilityManifest): Record<string, string> => ({
    "core.models": m.core.models.map((x) => x.id).join(","),
    "core.canResume": String(m.core.canResume),
    "core.canMcp": String(m.core.canMcp),
    "core.supportsMidRunInput": String(m.core.supportsMidRunInput),
    "core.reportsUsage": String(m.core.reportsUsage),
    "core.reportsLimits": String(m.core.reportsLimits),
    "core.execution.shell": String(m.core.execution.shell),
    "core.execution.filesystem": String(m.core.execution.filesystem),
    "core.execution.web": m.core.execution.web,
    "core.auth.state": m.core.auth.state,
  });
  const a = flatten(prev);
  const b = flatten(next);
  for (const key of Object.keys(b)) {
    if (a[key] !== b[key]) changes.push({ field: key, oldValue: a[key] ?? "", newValue: b[key]! });
  }
  return changes;
}
