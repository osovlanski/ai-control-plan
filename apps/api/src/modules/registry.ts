import type { AgentAdapter, AssistantId, CapabilityManifest } from "@agent-plane/core";
import { ClaudeAdapter, CodexAdapter, FakeAdapter } from "@agent-plane/adapters";
import type { ResolvedConfig } from "../config.js";
import type { Db } from "../db/index.js";

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
  ) {}

  /** Seed assistants table + adapter instances from config. Call at boot. */
  init(): void {
    const upsert = this.db.prepare(
      `INSERT INTO assistants (id, provider, enabled) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, enabled = excluded.enabled`,
    );
    for (const [id, cfg] of Object.entries(this.config.assistants)) {
      this.adapters.set(id, createAdapter(id as AssistantId, cfg.provider));
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

  recentChanges(limit = 50): unknown[] {
    return this.db
      .prepare(
        "SELECT assistant_id, field, old_value, new_value, source, observed_at FROM capability_changes ORDER BY id DESC LIMIT ?",
      )
      .all(limit);
  }
}

function createAdapter(id: AssistantId, provider: string): AgentAdapter {
  switch (provider) {
    case "anthropic":
      return new ClaudeAdapter(id);
    case "openai":
      return new CodexAdapter(id);
    case "fake":
      return new FakeAdapter(id);
    default:
      throw new Error(`Unsupported provider "${provider}" for assistant ${id} (Phase 1 supports anthropic, openai, fake)`);
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
