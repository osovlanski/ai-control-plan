/**
 * qcq-04a: account identity (review packet 2.2) and the enforcement gate (2.12).
 *
 * The plane cannot discover which assistants share a provider account (`core.auth.account` labels
 * an environment credential, not an account), so the operator declares it under
 * `scheduling.accounts`. 04a ships the resolver and config with enforcement off only: no account
 * claim is written, and `enforce: true` is refused at load while `ACCOUNT_ENFORCEMENT_READY` is
 * false. 04d flips the constant.
 */

import { createHash } from "node:crypto";

/** The build gate. Config load is its only reader (packet 2.12). */
export const ACCOUNT_ENFORCEMENT_READY = false;

export type RunAsIdentity = "plane" | "agent";

export interface AccountMember { assistant: string; runAs: RunAsIdentity }
export interface AccountGroup { provider: string; limit: number; members: AccountMember[] }

export interface ResolvedAccountsConfig {
  /** false: no account claims, today's dispatch. */
  enforce: boolean;
  /** Limit of an undeclared assistant's own fallback account; null = no account requirement. */
  defaultLimit: number | null;
  /** Bound on inherited queue keys along a successor chain (2.5.1). Read only with enforcement on. */
  maxInheritedKeys: number;
  groups: Record<string, AccountGroup>;
}

export const DEFAULT_ACCOUNTS: ResolvedAccountsConfig = Object.freeze({ enforce: false, defaultLimit: null, maxInheritedKeys: 3, groups: {} }) as ResolvedAccountsConfig;

export type AccountSource = "declared" | "fallback" | "none";
export interface AccountIdentity { key: string | null; source: AccountSource; limit: number | null }

const LABEL = /^[a-z0-9-]{1,40}$/;
const KEYS = ["enforce", "defaultLimit", "maxInheritedKeys", "groups"];
const GROUP_KEYS = ["provider", "limit", "members"];
const MEMBER_KEYS = ["assistant", "runAs"];
const positiveInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1;

/**
 * Parses and validates `scheduling.accounts`. Every problem is collected, then thrown together.
 * `assistants` maps assistant id to its configured provider family; `pools` are the
 * `scheduler.resources` names (the `account:` prefix is reserved for account keys).
 */
export function resolveAccounts(
  raw: unknown,
  ctx: { assistants: Record<string, { provider: string }>; pools: string[]; schedulerEnabled: boolean; ready?: boolean },
  configPath: string,
): ResolvedAccountsConfig {
  const problems: string[] = [];
  for (const pool of ctx.pools) {
    if (pool.startsWith("account:")) problems.push(`scheduler.resources.${pool}: the account: prefix is reserved for account keys`);
  }
  if (raw === undefined || raw === null) {
    if (problems.length) throw new Error(`Invalid config at ${configPath}:\n  - ${problems.join("\n  - ")}`);
    return DEFAULT_ACCOUNTS;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${configPath}: scheduling.accounts must be a mapping`);
  const f = raw as Record<string, unknown>;
  const unknown = Object.keys(f).filter((k) => !KEYS.includes(k));
  if (unknown.length) problems.push(`scheduling.accounts has unknown key(s): ${unknown.join(", ")}`);

  const enforce = f.enforce ?? false;
  if (typeof enforce !== "boolean") problems.push("scheduling.accounts.enforce must be true or false");
  const defaultLimit = f.defaultLimit ?? null;
  if (defaultLimit !== null && !positiveInt(defaultLimit)) problems.push("scheduling.accounts.defaultLimit must be a positive integer or null");
  const maxInheritedKeys = f.maxInheritedKeys ?? 3;
  if (!(typeof maxInheritedKeys === "number" && Number.isInteger(maxInheritedKeys) && maxInheritedKeys >= 0)) {
    problems.push("scheduling.accounts.maxInheritedKeys must be a non-negative integer");
  }

  const groups: Record<string, AccountGroup> = {};
  const seen = new Map<string, string>();
  const rawGroups = f.groups ?? {};
  if (typeof rawGroups !== "object" || rawGroups === null || Array.isArray(rawGroups)) {
    problems.push("scheduling.accounts.groups must be a mapping");
  } else {
    for (const [label, g] of Object.entries(rawGroups as Record<string, unknown>)) {
      const at = `scheduling.accounts.groups.${label}`;
      if (!LABEL.test(label) || label === "fallback") {
        problems.push(`${at}: a group label is [a-z0-9-]{1,40} and not "fallback"`);
      }
      if (typeof g !== "object" || g === null || Array.isArray(g)) { problems.push(`${at} must be a mapping`); continue; }
      const gr = g as Record<string, unknown>;
      const extra = Object.keys(gr).filter((k) => !GROUP_KEYS.includes(k));
      if (extra.length) problems.push(`${at} has unknown key(s): ${extra.join(", ")}`);
      if (typeof gr.provider !== "string" || !gr.provider) problems.push(`${at}.provider must be a provider family`);
      if (!positiveInt(gr.limit)) problems.push(`${at}.limit must be a positive integer`);
      if (!Array.isArray(gr.members) || gr.members.length === 0) { problems.push(`${at}.members must list at least one member`); continue; }
      const members: AccountMember[] = [];
      gr.members.forEach((m: unknown, i: number) => {
        const mAt = `${at}.members[${i}]`;
        if (typeof m !== "object" || m === null || Array.isArray(m)) { problems.push(`${mAt} must be { assistant, runAs }`); return; }
        const mr = m as Record<string, unknown>;
        const mExtra = Object.keys(mr).filter((k) => !MEMBER_KEYS.includes(k));
        if (mExtra.length) problems.push(`${mAt} has unknown key(s): ${mExtra.join(", ")}`);
        if (typeof mr.assistant !== "string" || !mr.assistant) { problems.push(`${mAt}.assistant must be an assistant id`); return; }
        if (mr.runAs !== "plane" && mr.runAs !== "agent") { problems.push(`${mAt}.runAs must be plane or agent`); return; }
        const assistant = ctx.assistants[mr.assistant];
        if (!assistant) problems.push(`${mAt}: assistant ${mr.assistant} is not configured`);
        else if (typeof gr.provider === "string" && assistant.provider !== gr.provider) {
          problems.push(`${mAt}: assistant ${mr.assistant} is provider ${assistant.provider}, not the group's ${gr.provider}`);
        }
        const pair = `${mr.assistant}/${mr.runAs}`;
        const prior = seen.get(pair);
        if (prior !== undefined) problems.push(`${mAt}: ${pair} is already a member of group ${prior}; a pair belongs to at most one group`);
        else seen.set(pair, label);
        members.push({ assistant: mr.assistant, runAs: mr.runAs });
      });
      groups[label] = { provider: gr.provider as string, limit: gr.limit as number, members };
    }
  }

  if (enforce === true) {
    // The build gate first: until 04d, nothing else about an enforced config matters.
    if (!(ctx.ready ?? ACCOUNT_ENFORCEMENT_READY)) problems.push("scheduling.accounts.enforce: account enforcement is not available in this build");
    else if (!ctx.schedulerEnabled) problems.push("scheduling.accounts.enforce: true requires scheduler.enabled: true");
  }
  if (problems.length) throw new Error(`Invalid config at ${configPath}:\n  - ${problems.join("\n  - ")}`);
  return { enforce: enforce as boolean, defaultLimit: defaultLimit as number | null, maxInheritedKeys: maxInheritedKeys as number, groups };
}

/**
 * The resolver of packet 2.2. The execution identity is the pair (assistant, runAs): a declared
 * member resolves to its group's key; anything else to its own fallback key when `defaultLimit`
 * is set, and otherwise to no account requirement.
 */
export function accountKey(cfg: ResolvedAccountsConfig, assistantId: string, runAs: RunAsIdentity): AccountIdentity {
  for (const [label, g] of Object.entries(cfg.groups)) {
    if (g.members.some((m) => m.assistant === assistantId && m.runAs === runAs)) return { key: `account:${label}`, source: "declared", limit: g.limit };
  }
  if (cfg.defaultLimit !== null) return { key: `account:fallback:${runAs}:${assistantId}`, source: "fallback", limit: cfg.defaultLimit };
  return { key: null, source: "none", limit: null };
}

/**
 * The limit of an account key under this config (packet 2.2), or undefined when the key names no
 * account it defines: an undeclared group, or a fallback key with `defaultLimit` null.
 */
export function accountLimit(cfg: ResolvedAccountsConfig, key: string): number | undefined {
  if (!key.startsWith("account:")) return undefined;
  const rest = key.slice("account:".length);
  if (rest.startsWith("fallback:")) return cfg.defaultLimit ?? undefined;
  return cfg.groups[rest]?.limit;
}

/**
 * `account_config_hash` (packet 2.2): a hash of the definition the key was resolved from, so a commit
 * or a boot can tell a regrouped or re-limited account from the one the attempt was queued under.
 */
export function accountConfigHash(cfg: ResolvedAccountsConfig, identity: AccountIdentity): string | null {
  if (!identity.key) return null;
  const rest = identity.key.slice("account:".length);
  const def = identity.source === "fallback" ? { fallback: cfg.defaultLimit } : cfg.groups[rest] ?? null;
  return createHash("sha256").update(JSON.stringify({ key: identity.key, def })).digest("hex").slice(0, 16);
}
