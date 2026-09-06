import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AssistantId, QuotaObservation } from '@agent-plane/core';
import type { Db } from '../db/index.js';
import type { ResolvedConfig } from '../config.js';
import type { Registry } from './registry.js';

/** One attempt per assistant per window; `status()` reports the age. */
export const PROBE_INTERVAL_MS = 15 * 60_000;
const PROBE_TIMEOUT_MS = 5_000;

export type ProbeStatus = 'ok' | 'unavailable' | 'unauthorized' | 'unsupported';
export interface ProbeOutcome {
  status: ProbeStatus;
  /** Empty unless `ok`. `bucket` is the provider's own window name. */
  buckets: Array<{ bucket: string; usedPercent: number; resetsAt?: string }>;
  /** Classified reason. Never a response body, never a credential. */
  detail?: string;
}
export type QuotaProbeFn = (provider: string, options: Record<string, unknown>) => Promise<ProbeOutcome>;

/**
 * Idle headroom probes sit outside the six-method adapter contract (like
 * `capability-probe.ts`) and are optional and account-specific: they exist only
 * where a provider account exposes an idle endpoint and the operator turns them
 * on. A probe is evidence about one account and bucket — never a manifest
 * capability, so `reportsLimits` (which describes the run stream) is untouched.
 */
export async function probeQuota(provider: string, options: Record<string, unknown> = {}): Promise<ProbeOutcome> {
  if (provider === 'anthropic') return probeClaudeUsage(options);
  // The Codex app-server RPC `account/rateLimits/read` is observed in Omarchy's
  // script but absent from the documented App Server page; unsupported until it
  // is verified against a running app-server rather than faked here.
  return { status: 'unsupported', buckets: [], detail: `no verified idle quota endpoint for ${provider}` };
}

/** The OAuth token is read into a local: never returned, logged or persisted. */
async function probeClaudeUsage(options: Record<string, unknown>): Promise<ProbeOutcome> {
  const path = typeof options.credentialsPath === 'string' ? options.credentialsPath : join(homedir(), '.claude', '.credentials.json');
  const endpoint = typeof options.usageEndpoint === 'string' ? options.usageEndpoint : 'https://api.anthropic.com/api/oauth/usage';
  let token: string | undefined;
  try {
    token = (JSON.parse(readFileSync(path, 'utf8')) as { claudeAiOauth?: { accessToken?: string } })?.claudeAiOauth?.accessToken;
  } catch {
    return { status: 'unauthorized', buckets: [], detail: 'no readable OAuth credentials' };
  }
  if (!token) return { status: 'unauthorized', buckets: [], detail: 'no OAuth access token' };
  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch {
    // Deliberately not the thrown error: a fetch failure can echo the request.
    return { status: 'unavailable', buckets: [], detail: 'usage endpoint unreachable' };
  }
  if (response.status === 401 || response.status === 403) return { status: 'unauthorized', buckets: [], detail: `usage endpoint rejected the credential (${response.status})` };
  if (!response.ok) return { status: 'unavailable', buckets: [], detail: `usage endpoint returned ${response.status}` };
  let body: Record<string, unknown>;
  try { body = (await response.json()) as Record<string, unknown>; } catch { return { status: 'unavailable', buckets: [], detail: 'usage endpoint returned unreadable JSON' }; }
  const buckets = Object.entries(body).flatMap(([bucket, value]) => {
    const window = value as { utilization?: unknown; resets_at?: unknown } | null;
    if (!window || typeof window !== 'object' || typeof window.utilization !== 'number') return [];
    const resetsAt = typeof window.resets_at === 'string' && Number.isFinite(Date.parse(window.resets_at)) ? new Date(window.resets_at).toISOString() : undefined;
    return [{ bucket, usedPercent: window.utilization, resetsAt }];
  });
  return buckets.length ? { status: 'ok', buckets } : { status: 'unavailable', buckets: [], detail: 'usage endpoint reported no windows' };
}

export interface ProbeAttempt { assistantId: string; status: ProbeStatus | 'skipped-fresh'; attemptedAt: string; detail?: string }

/**
 * Runs due probes and turns their results into `provider-api` observations the
 * shared `QuotaProjection` already reads. Attempts are recorded separately from
 * the wake budget: they never touch `auto_wakes`.
 */
export class QuotaProbeService {
  constructor(
    private db: Db,
    private config: ResolvedConfig,
    private registry: Registry,
    private probe: QuotaProbeFn = probeQuota,
    private now: () => Date = () => new Date(),
  ) {}

  get enabled(): boolean { return this.config.scheduler?.quotaProbe === true; }

  /** Attempt rows with their age, for `GET /api/scheduler/status`. */
  status(): Array<{ assistantId: string; attemptedAt: string; outcome: ProbeStatus; ageMs: number; detail?: string }> {
    const now = this.now().getTime();
    return (this.db.prepare('SELECT * FROM quota_probes ORDER BY assistant_id').all() as Array<{ assistant_id: string; attempted_at: string; outcome: ProbeStatus; detail: string | null }>)
      .map(r => ({ assistantId: r.assistant_id, attemptedAt: r.attempted_at, outcome: r.outcome, ageMs: now - Date.parse(r.attempted_at), detail: r.detail ?? undefined }));
  }

  private due(assistantId: string): boolean {
    const row = this.db.prepare('SELECT attempted_at FROM quota_probes WHERE assistant_id = ?').get(assistantId) as { attempted_at: string } | undefined;
    return !row || this.now().getTime() - Date.parse(row.attempted_at) >= PROBE_INTERVAL_MS;
  }

  /** Probes the named assistants (default: every enabled one). Never throws. */
  async refresh(assistantIds?: string[]): Promise<ProbeAttempt[]> {
    if (!this.enabled) return [];
    const attempts: ProbeAttempt[] = [];
    for (const a of this.registry.list()) {
      if (a.enabled !== 1 || !a.manifestParsed) continue;
      if (assistantIds?.length && !assistantIds.includes(a.id)) continue;
      const at = this.now().toISOString();
      if (!this.due(a.id)) { attempts.push({ assistantId: a.id, status: 'skipped-fresh', attemptedAt: at }); continue; }
      let outcome: ProbeOutcome;
      try {
        outcome = await this.probe(a.provider, this.config.assistants[a.id]?.options ?? {});
      } catch {
        outcome = { status: 'unavailable', buckets: [], detail: 'probe threw' };
      }
      this.record(a.id, outcome, a.manifestParsed.core.auth.account);
      attempts.push({ assistantId: a.id, status: outcome.status, attemptedAt: at, detail: outcome.detail });
    }
    return attempts;
  }

  private record(assistantId: string, outcome: ProbeOutcome, account?: string): void {
    this.db.transaction(() => {
      const at = this.now().toISOString();
      this.db.prepare(`INSERT INTO quota_probes(assistant_id,attempted_at,outcome,detail) VALUES(?,?,?,?)
        ON CONFLICT(assistant_id) DO UPDATE SET attempted_at = excluded.attempted_at, outcome = excluded.outcome, detail = excluded.detail`)
        .run(assistantId, at, outcome.status, outcome.detail ?? null);
      // Only a successful probe is evidence; anything else changes nothing.
      if (outcome.status !== 'ok') return;
      const insert = this.db.prepare("INSERT INTO quota_snapshots (assistant_id, window, used_percent, resets_at, source, observed_at, account) VALUES (?, ?, ?, ?, 'provider-api', ?, ?)");
      for (const b of outcome.buckets) insert.run(assistantId, b.bucket, b.usedPercent, b.resetsAt ?? null, at, account ?? null);
    })();
  }

  /** Probe observations newest first, for idle headroom display. */
  observations(assistantId: string): QuotaObservation[] {
    return (this.db.prepare("SELECT * FROM quota_snapshots WHERE assistant_id = ? AND source = 'provider-api' ORDER BY observed_at DESC, id DESC").all(assistantId) as Array<{ window: string; account: string | null; used_percent: number; resets_at: string | null; observed_at: string }>)
      .map(r => ({ assistantId: assistantId as AssistantId, scope: { account: r.account ?? undefined, bucket: r.window }, usedPercent: r.used_percent, resetsAt: r.resets_at ?? undefined, source: 'provider-api' as const, observedAt: r.observed_at }));
  }
}
