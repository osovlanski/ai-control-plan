import { planVerification, type VerificationPlan } from "@agent-plane/core";
import type { WorkspaceAuthority } from "./harness/workspace-authority.js";

const SCRIPT_KINDS = ["test", "typecheck", "lint"] as const;
type PackageManager = "npm" | "pnpm" | "yarn" | "bun";
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
const PACKAGE_MANAGER = /^(npm|pnpm|yarn|bun)@[0-9A-Za-z][0-9A-Za-z.+_-]*$/;
const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ["package-lock.json", "npm"], ["npm-shrinkwrap.json", "npm"],
  ["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"],
  ["bun.lock", "bun"], ["bun.lockb", "bun"],
];

/** Bounded, authority-produced input to the pure planner adapter. */
export interface ProjectVerificationSnapshot { packageJson?: string; lockfiles: string[] }
export interface ProjectVerificationDiscovery { plan?: VerificationPlan; warnings: string[] }

/** All filesystem access stays behind the Harness's existing authority. */
export function snapshotProjectVerification(authority: WorkspaceAuthority, worktreePath: string): ProjectVerificationSnapshot {
  const packageJson = authority.readRegularFile(worktreePath, "package.json", MAX_PACKAGE_JSON_BYTES);
  if (packageJson === undefined) return { lockfiles: [] };
  const lockfiles = LOCKFILES.map(([name]) => name).filter((name) => authority.regularFileExists(worktreePath, name));
  return { packageJson, lockfiles };
}

function packageManagerOf(declared: unknown, lockfiles: readonly string[]): { manager?: PackageManager; warning?: string } {
  if (declared !== undefined) {
    if (typeof declared !== "string" || !PACKAGE_MANAGER.test(declared)) {
      return { warning: "project verification skipped: malformed packageManager declaration" };
    }
    return { manager: declared.slice(0, declared.indexOf("@")) as PackageManager };
  }
  if (lockfiles.length !== 1) {
    return { warning: lockfiles.length === 0
      ? "project verification skipped: no packageManager declaration or recognized lockfile"
      : "project verification skipped: ambiguous package-manager lockfiles" };
  }
  return { manager: LOCKFILES.find(([name]) => name === lockfiles[0])?.[1] };
}

/** Pure conversion from a bounded project snapshot to the core planner. */
export function planProjectVerification(snapshot: ProjectVerificationSnapshot): ProjectVerificationDiscovery {
  if (snapshot.packageJson === undefined) return { warnings: [] };
  let manifest: unknown;
  try { manifest = JSON.parse(snapshot.packageJson); }
  catch { return { warnings: ["project verification skipped: malformed package.json"] }; }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { warnings: ["project verification skipped: package.json must contain an object"] };
  }
  const record = manifest as Record<string, unknown>;
  const scripts = record.scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return { warnings: [] };
  const scriptRecord = scripts as Record<string, unknown>;
  const discovered = SCRIPT_KINDS.filter(
    (name) => Object.prototype.hasOwnProperty.call(scriptRecord, name) && typeof scriptRecord[name] === "string",
  );
  if (discovered.length === 0) return { warnings: [] };

  const resolved = packageManagerOf(record.packageManager, snapshot.lockfiles);
  if (!resolved.manager) return { warnings: resolved.warning ? [resolved.warning] : [] };
  const capabilities = discovered.map((name) => ({
    checkId: `project:${name}`,
    name: `project ${name}`,
    kind: name === "test" ? "tests" as const : name,
    provider: "native",
    command: `${resolved.manager} run ${name}`,
    required: true,
  }));
  return {
    plan: planVerification({
      changedFiles: [],
      explicitRequiredKinds: capabilities.map(({ kind }) => kind),
      capabilities,
    }),
    warnings: [],
  };
}
