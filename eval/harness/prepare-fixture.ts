/**
 * Fixture isolation (increment 3, plan §4 step 20, Codex round-1 finding #9).
 *
 * A fixture directory inside this repo is not an independent repository, and
 * `startTask`/`WorkspaceAuthority` expect an allowlisted repo/worktree — using
 * a fixture in place risks branching/worktree'ing the whole control-plane repo
 * or mutating a fixture shared by concurrent scenario runs. Every scenario
 * gets a fresh, disposable copy.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES_ROOT = fileURLToPath(new URL("../fixtures/", import.meta.url));

export interface PreparedFixture {
  /** Absolute path to the fresh, git-initialised copy. Add this to `repoAllowlist`. */
  path: string;
  /** Deletes the temp copy. Always call this in a `finally`. */
  cleanup: () => void;
}

/** Copy `eval/fixtures/<name>/` to a fresh temp dir and commit it as a standalone git repo. */
export function prepareFixture(name: string): PreparedFixture {
  const src = join(FIXTURES_ROOT, name);
  const dir = mkdtempSync(join(tmpdir(), `agent-plane-eval-${name}-`));
  cpSync(src, dir, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "eval@agent-plane.local");
  git("config", "user.name", "Agent Plane Eval");
  git("add", "-A");
  git("commit", "-qm", "initial fixture state");
  return { path: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Digest of the fixture's committed tree — recorded in the scorecard for reproducibility (R1-#16). */
export function fixtureDigest(preparedPath: string): string {
  return execFileSync("git", ["-C", preparedPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}
