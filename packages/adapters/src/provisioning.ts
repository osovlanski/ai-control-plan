/**
 * M3 provisioning (docs/agentic-os-plan.md §3.4): turn a composed revision's bundle into a per-run
 * profile directory the plane owns, prove it, and remove it.
 *
 * Rules this file enforces, whichever adapter calls it:
 * - It writes only under the root the plane passed, never under `~/.claude`, `~/.codex` or
 *   `~/.cursor`, and never through a symlink.
 * - Materializing is atomic (a staging directory renamed into place) and idempotent for the same
 *   plan; an existing directory without this profile's ownership marker is never touched.
 * - No secret value is ever part of a plan, a file or a digest. Secret references are names.
 * - The profile digest carries no absolute path and no time, so one revision gives one digest.
 */
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  BundleResponse,
  ProfileFile,
  ProfileLaunch,
  ProvisionedHarness,
  ProvisionedProfile,
  ProvisioningCheck,
  ProvisioningInput,
  ProvisioningPlan,
  ProvisioningVerification,
  VerifiedProfile,
} from "@agent-plane/core";
import { jcs, ProvisioningError } from "@agent-plane/core";

export const PROFILE_MARKER = ".agent-plane-profile.json";
const PLUGIN_NAME = "agent-plane-profile";
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SKILL_PATH = /^\.claude\/skills\/([A-Za-z0-9][A-Za-z0-9_.-]*)\/SKILL\.md$/;

export const sha256 = (text: string) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

/** The machine-global config directories provisioning must never write into (§3.4). */
export function globalConfigDirs(home = homedir()): string[] {
  return [".claude", ".codex", ".cursor"].map((d) => join(home, d));
}

const inside = (child: string, parent: string) => child === parent || child.startsWith(parent + sep);

/** Throws `invalid_root` unless `root` is an absolute, normalized directory path outside global config. */
export function assertProfileRoot(root: string, home = homedir()): void {
  if (!isAbsolute(root) || resolve(root) !== root) throw new ProvisioningError("invalid_root", "profile root must be an absolute, normalized path");
  if (dirname(root) === root) throw new ProvisioningError("invalid_root", "profile root must not be a filesystem root");
  if (inside(home, root)) throw new ProvisioningError("invalid_root", "profile root must not contain the home directory");
  for (const dir of globalConfigDirs(home)) {
    if (inside(root, dir)) throw new ProvisioningError("invalid_root", "profile root must not be inside a machine-global assistant config directory");
  }
}

/** The bundle must be the revision's, for this harness, with every file matching its digest. */
function checkedBundle(input: ProvisioningInput, harness: ProvisionedHarness): BundleResponse {
  const { spec, bundle } = input;
  if (spec.harness !== harness) throw new ProvisioningError("harness_mismatch", `revision ${spec.composition_revision_id} is composed for ${spec.harness}, not ${harness}`);
  if (bundle.manifest.harness !== harness) throw new ProvisioningError("harness_mismatch", `bundle was rendered for ${bundle.manifest.harness}, not ${harness}`);
  if (bundle.manifest.bundleDigest !== spec.context.bundle_digest) throw new ProvisioningError("invalid_bundle", "bundle digest differs from the revision's context.bundle_digest");
  for (const f of bundle.files) {
    if (sha256(f.content) !== f.digest) throw new ProvisioningError("invalid_bundle", `bundle file ${f.relPath} does not match its digest`);
  }
  if (spec.assets.mcp_servers.length > 0) throw new ProvisioningError("unsupported_asset", "MCP servers are not provisioned yet (M3 S4)");
  if (spec.assets.subagents.length > 0) throw new ProvisioningError("unsupported_asset", "subagents are not provisioned yet");
  if (!SESSION_ID.test(input.sessionId)) throw new ProvisioningError("invalid_root", "session id is not a safe directory name");
  assertProfileRoot(input.root);
  return bundle;
}

const file = (relPath: string, content: string): ProfileFile => ({ relPath, content, digest: sha256(content) });
const byPath = (a: { relPath: string }, b: { relPath: string }) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0);

/** The launch shape that is digested: content by digest, paths relative to the root. */
function launchShape(launch: ProfileLaunch, root: string): unknown {
  if (launch.harness === "claude-code") {
    return {
      harness: launch.harness,
      settingSources: launch.settingSources,
      pluginDir: launch.pluginDir === undefined ? undefined : relative(root, launch.pluginDir),
      systemPromptAppend: launch.systemPromptAppend === undefined ? undefined : sha256(launch.systemPromptAppend),
      strictMcpConfig: launch.strictMcpConfig,
      mcpServers: launch.mcpServers,
      disableClaudeAiConnectors: launch.disableClaudeAiConnectors,
    };
  }
  return {
    harness: launch.harness,
    config: Object.fromEntries(Object.entries(launch.config).map(([k, v]) => [k, v === undefined ? undefined : sha256(v)])),
  };
}

export function computeProfileDigest(plan: Pick<ProvisioningPlan, "harness" | "files" | "launch" | "root">): string {
  return sha256(jcs({
    schemaVersion: 1,
    harness: plan.harness,
    files: [...plan.files].sort(byPath).map(({ relPath, digest }) => ({ relPath, digest })),
    launch: launchShape(plan.launch, plan.root),
  }, "integer"));
}

function plan(input: ProvisioningInput, rest: Omit<ProvisioningPlan, "schemaVersion" | "compositionRevisionId" | "sessionId" | "root" | "secretRefs" | "profileDigest">): ProvisioningPlan {
  const base = {
    schemaVersion: 1 as const,
    compositionRevisionId: input.spec.composition_revision_id,
    sessionId: input.sessionId,
    root: input.root,
    ...rest,
    files: [...rest.files].sort(byPath),
    secretRefs: [],
  };
  return { ...base, profileDigest: computeProfileDigest(base) };
}

/**
 * Claude Code: `full`. The run loads only `project` settings (the worktree's own), the selected
 * skills arrive as a per-run local plugin, MCP is strict with no servers, claude.ai connectors are
 * off, and the bundle's CLAUDE.md is appended to the preset system prompt.
 */
export function claudeProvisioningPlan(input: ProvisioningInput): ProvisioningPlan {
  const bundle = checkedBundle(input, "claude-code");
  const files: ProfileFile[] = [];
  let systemPromptAppend: string | undefined;
  const skills: string[] = [];
  for (const f of bundle.files) {
    const skill = SKILL_PATH.exec(f.relPath);
    if (f.relPath === "CLAUDE.md") {
      systemPromptAppend = f.content;
      files.push(file("CLAUDE.md", f.content));
    } else if (skill) {
      skills.push(skill[1]!);
      files.push(file(`plugin/skills/${skill[1]}/SKILL.md`, f.content));
    } else {
      throw new ProvisioningError("invalid_bundle", `claude-code bundle file ${f.relPath} is outside the bundle v1 allowlist`);
    }
  }
  if (skills.length > 0) {
    files.push(file("plugin/.claude-plugin/plugin.json", `${JSON.stringify({
      name: PLUGIN_NAME,
      version: "1.0.0",
      // No revision id here: the profile is content-addressed, so equal bundles give equal digests.
      description: "Skills the agent plane composed for one run",
    }, null, 2)}\n`));
  }
  return plan(input, {
    harness: "claude-code",
    files,
    launch: {
      harness: "claude-code",
      settingSources: ["project"],
      ...(skills.length > 0 ? { pluginDir: join(input.root, "plugin") } : {}),
      ...(systemPromptAppend !== undefined ? { systemPromptAppend } : {}),
      strictMcpConfig: true,
      mcpServers: {},
      disableClaudeAiConnectors: true,
    },
    fidelity: "full",
    visible: [
      "the worktree's project settings, CLAUDE.md, skills and agents (.claude/)",
      "managed policy settings",
      "provider authentication",
    ],
    excluded: [
      "user settings and CLAUDE.md (~/.claude)",
      "user skills, agents, commands and plugins",
      "local settings (.claude/settings.local.json)",
      "MCP servers from user and project config",
      "claude.ai connectors",
    ],
  });
}

/**
 * Codex: `partial`. The bundle's AGENTS.md is delivered as `developer_instructions` on a per-run
 * Codex instance. `~/.codex` stays visible: moving CODEX_HOME would move `auth.json` with it.
 */
export function codexProvisioningPlan(input: ProvisioningInput): ProvisioningPlan {
  const bundle = checkedBundle(input, "codex");
  const files: ProfileFile[] = [];
  let instructions: string | undefined;
  for (const f of bundle.files) {
    if (f.relPath !== "AGENTS.md") throw new ProvisioningError("invalid_bundle", `codex bundle file ${f.relPath} is outside the bundle v1 allowlist`);
    instructions = f.content;
    files.push(file("AGENTS.md", f.content));
  }
  return plan(input, {
    harness: "codex",
    files,
    launch: { harness: "codex", config: instructions !== undefined ? { developer_instructions: instructions } : {} },
    fidelity: "partial",
    visible: [
      "~/.codex/config.toml (model, MCP servers, profiles, features)",
      "~/.codex/AGENTS.md",
      "~/.codex/skills",
      "the worktree's AGENTS.md files",
    ],
    excluded: [],
  });
}

interface Marker { owner: "agent-plane"; sessionId: string; compositionRevisionId: string; profileDigest: string }

const markerFor = (p: ProvisioningPlan): Marker => ({ owner: "agent-plane", sessionId: p.sessionId, compositionRevisionId: p.compositionRevisionId, profileDigest: p.profileDigest });

function readMarker(root: string): Marker | undefined {
  try {
    const st = lstatSync(join(root, PROFILE_MARKER));
    if (!st.isFile()) return undefined;
    return JSON.parse(readFileSync(join(root, PROFILE_MARKER), "utf8")) as Marker;
  } catch {
    return undefined;
  }
}

const sameMarker = (a: Marker | undefined, b: Marker) =>
  !!a && a.owner === b.owner && a.sessionId === b.sessionId && a.compositionRevisionId === b.compositionRevisionId && a.profileDigest === b.profileDigest;

function lstatOrUndefined(path: string) {
  try {
    return lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** Write the plan atomically under its root. The same plan twice is a no-op; anything else at the root is refused. */
export function materializeProfile(p: ProvisioningPlan, harness: ProvisionedHarness): ProvisionedProfile {
  if (p.harness !== harness) throw new ProvisioningError("harness_mismatch", `plan is for ${p.harness}, not ${harness}`);
  assertProfileRoot(p.root);
  if (computeProfileDigest(p) !== p.profileDigest) throw new ProvisioningError("digest_mismatch", "plan does not match its profile digest");
  const profile: ProvisionedProfile = { plan: p, marker: PROFILE_MARKER };
  const existing = lstatOrUndefined(p.root);
  if (existing) {
    if (!existing.isSymbolicLink() && existing.isDirectory() && sameMarker(readMarker(p.root), markerFor(p))) return profile;
    throw new ProvisioningError("unowned_path", "profile root already exists and is not this profile");
  }
  mkdirSync(dirname(p.root), { recursive: true, mode: 0o700 });
  const staging = `${p.root}.staging-${randomUUID()}`;
  try {
    mkdirSync(staging, { mode: 0o700 });
    for (const f of p.files) {
      const target = join(staging, f.relPath);
      if (!inside(target, staging)) throw new ProvisioningError("invalid_bundle", `profile file ${f.relPath} escapes the root`);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, f.content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    }
    writeFileSync(join(staging, PROFILE_MARKER), `${JSON.stringify(markerFor(p))}\n`, { mode: 0o600, flag: "wx" });
    renameSync(staging, p.root);
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    if ((err as NodeJS.ErrnoException).code === "ENOTEMPTY" || (err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ProvisioningError("unowned_path", "profile root appeared while provisioning");
    }
    throw err;
  }
  return profile;
}

/** Every entry under `dir`, relative, with symlinks reported rather than followed. */
function walk(dir: string, base = dir): Array<{ relPath: string; kind: "file" | "dir" | "other" }> {
  const out: Array<{ relPath: string; kind: "file" | "dir" | "other" }> = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = lstatSync(abs);
    const relPath = relative(base, abs).split(sep).join("/");
    if (st.isDirectory()) {
      out.push({ relPath, kind: "dir" });
      out.push(...walk(abs, base));
    } else out.push({ relPath, kind: st.isFile() ? "file" : "other" });
  }
  return out;
}

/** Prove the profile on disk is exactly the plan. Never throws for a failed check. */
export function verifyProfileOnDisk(profile: ProvisionedProfile, harness: ProvisionedHarness, evidence: ProvisioningCheck[] = []): ProvisioningVerification {
  const p = profile.plan;
  const checks: ProvisioningCheck[] = [];
  const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  check("harness", p.harness === harness, `plan for ${p.harness}, adapter ${harness}`);
  check("plan_digest", computeProfileDigest(p) === p.profileDigest, "the plan recomputes to its profile digest");
  try {
    assertProfileRoot(p.root);
    const st = lstatOrUndefined(p.root);
    check("root", !!st && st.isDirectory() && !st.isSymbolicLink(), "profile root is a real directory outside global config");
    check("marker", sameMarker(readMarker(p.root), markerFor(p)), "ownership marker names this session, revision and digest");
    let filesOk = true;
    for (const f of p.files) {
      const fst = lstatOrUndefined(join(p.root, f.relPath));
      if (!fst || !fst.isFile() || sha256(readFileSync(join(p.root, f.relPath), "utf8")) !== f.digest) filesOk = false;
    }
    check("files", filesOk, `${p.files.length} file(s) present with their planned digests`);
    const expected = new Set([PROFILE_MARKER, ...p.files.map((f) => f.relPath)]);
    for (const f of p.files) {
      const parts = f.relPath.split("/");
      for (let i = 1; i < parts.length; i++) expected.add(parts.slice(0, i).join("/"));
    }
    const extra = st?.isDirectory() ? walk(p.root).filter((e) => !expected.has(e.relPath) || e.kind === "other") : [];
    check("no_extra_entries", extra.length === 0, extra.length === 0 ? "nothing outside the plan" : `${extra.length} unplanned or non-regular entr${extra.length === 1 ? "y" : "ies"}`);
  } catch (err) {
    check("root", false, err instanceof Error ? err.message : String(err));
  }
  if (p.launch.harness === "claude-code") {
    const l = p.launch;
    check("launch_scope", l.settingSources.every((s) => s === "project") && l.strictMcpConfig && Object.keys(l.mcpServers).length === 0 && l.disableClaudeAiConnectors,
      "settingSources excludes user and local; strict MCP with no servers; claude.ai connectors off");
    check("launch_paths", l.pluginDir === undefined || l.pluginDir === join(p.root, "plugin"), "plugin directory is inside the profile root");
  } else {
    const keys = Object.keys(p.launch.config);
    check("launch_scope", keys.every((k) => k === "developer_instructions"), `config overrides: ${keys.join(", ") || "none"}`);
  }
  checks.push(...evidence);
  const ok = checks.every((c) => c.ok);
  return { ok, fidelity: ok ? p.fidelity : "none", profileDigest: p.profileDigest, checks };
}

/** Remove a profile this plane owns. Idempotent; refuses a symlink or a directory without its marker. */
export function disposeProfileDir(profile: ProvisionedProfile): { removed: boolean } {
  const p = profile.plan;
  assertProfileRoot(p.root);
  const st = lstatOrUndefined(p.root);
  if (!st) return { removed: false };
  if (st.isSymbolicLink() || !st.isDirectory() || !sameMarker(readMarker(p.root), markerFor(p))) {
    throw new ProvisioningError("unowned_path", "refusing to remove a profile root this plane does not own");
  }
  rmSync(p.root, { recursive: true, force: true });
  return { removed: true };
}

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
};

/** The immutable profile a RunSpec launches with. Throws unless the verification passed for this plan. */
export function verifiedProfile(profile: ProvisionedProfile, verification: ProvisioningVerification): VerifiedProfile {
  const p = profile.plan;
  if (!verification.ok || verification.profileDigest !== p.profileDigest) {
    throw new ProvisioningError("digest_mismatch", "a profile is launched only after its own verification passed");
  }
  return deepFreeze(structuredClone({
    harness: p.harness,
    compositionRevisionId: p.compositionRevisionId,
    root: p.root,
    profileDigest: p.profileDigest,
    fidelity: verification.fidelity,
    files: p.files.map(({ relPath, digest }) => ({ relPath, digest })),
    launch: p.launch,
    visible: p.visible,
    excluded: p.excluded,
    checks: verification.checks,
  }));
}

/** An adapter given a profile for another harness refuses before any process starts (risk 9). */
export function requireProfileHarness(profile: VerifiedProfile | undefined, harness: ProvisionedHarness): void {
  if (profile && profile.harness !== harness) {
    throw new ProvisioningError("harness_mismatch", `run carries a ${profile.harness} profile; this adapter launches ${harness}`);
  }
}
