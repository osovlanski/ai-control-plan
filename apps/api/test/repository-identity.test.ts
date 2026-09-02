import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db/index.js";
import { RepositoryIdentityRegistry } from "../src/repo/identity-registry.js";

let root: string;
let db: Db;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function initRepo(name: string, remote?: string): string {
  const repo = join(root, name);
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.invalid");
  git(repo, "config", "user.name", "Test");
  git(repo, "commit", "--allow-empty", "-q", "-m", "initial");
  if (remote) git(repo, "remote", "add", "origin", remote);
  return repo;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agent-plane-identities-"));
  db = openDb(join(root, "registry.db"));
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("RepositoryIdentityRegistry", () => {
  it("is idempotent and assigns opaque ids without persisting remote credentials", async () => {
    const repo = initRepo("repo", "https://token:secret@example.invalid/Org/Private.git?auth=leak");
    const registry = new RepositoryIdentityRegistry(db);
    const first = await registry.resolve(repo);
    const second = await registry.resolve(repo);

    expect(second).toMatchObject(first);
    expect(first.workspaceId).toMatch(/^ws_/);
    expect(first.repositoryId).toMatch(/^repo_/);
    expect(first.worktreeId).toMatch(/^wt_/);
    expect(JSON.stringify(first)).not.toMatch(/repo\/|example|Private/);

    const stored = db
      .prepare("SELECT canonical_git_dir, remote_fingerprint FROM repository_identities")
      .all();
    const observations = db
      .prepare("SELECT observed_remote_fingerprint, source FROM repository_identity_observations")
      .all();
    expect(JSON.stringify({ stored, observations })).not.toMatch(/token|secret|auth=|example\.invalid|Private/);
  });

  it("keeps identities stable when the registry is reconstructed after restart", async () => {
    const repo = initRepo("restart", "https://host.invalid/Org/Repo.git");
    const first = await new RepositoryIdentityRegistry(db).resolve(repo);
    db.close();
    db = openDb(join(root, "registry.db"));
    const afterRestart = await new RepositoryIdentityRegistry(db).resolve(repo);

    expect(afterRestart).toMatchObject(first);
  });

  it("shares a repository id across linked worktrees but assigns distinct worktree ids", async () => {
    const repo = initRepo("repo", "git@example.invalid:Org/Repo.git");
    const linked = join(root, "linked");
    git(repo, "worktree", "add", "-q", "-b", "linked", linked);
    const registry = new RepositoryIdentityRegistry(db);

    const primary = await registry.resolve(repo);
    const worktree = await registry.resolve(linked);
    expect(worktree.repositoryId).toBe(primary.repositoryId);
    expect(worktree.worktreeId).not.toBe(primary.worktreeId);
  });

  it("keeps ids stable and records a conflict when a known path changes remote", async () => {
    const repo = initRepo("repo", "https://host.invalid/Org/One.git");
    const registry = new RepositoryIdentityRegistry(db);
    const first = await registry.resolve(repo);
    git(repo, "remote", "set-url", "origin", "https://host.invalid/Org/Two.git");
    const changed = await registry.resolve(repo);

    expect(changed.repositoryId).toBe(first.repositoryId);
    expect(changed.worktreeId).toBe(first.worktreeId);
    expect(changed.remoteConflict).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM repository_identity_observations WHERE conflict = 1").get()).toEqual({ n: 1 });
  });

  it("keeps ids stable when a supported remote is added after initial registration", async () => {
    const repo = initRepo("repo");
    const registry = new RepositoryIdentityRegistry(db);
    const localOnly = await registry.resolve(repo);
    git(repo, "remote", "add", "origin", "https://host.invalid/Org/Repo.git");
    const withRemote = await registry.resolve(repo);

    expect(withRemote.repositoryId).toBe(localOnly.repositoryId);
    expect(withRemote.worktreeId).toBe(localOnly.worktreeId);
    expect(withRemote.remoteConflict).toBe(false);
    expect(db.prepare("SELECT remote_fingerprint FROM repository_identities WHERE id = ?").get(localOnly.repositoryId))
      .toMatchObject({ remote_fingerprint: expect.stringMatching(/^[0-9a-f]{32}$/) });
  });

  it("does not merge separate realpaths merely because their remotes match", async () => {
    const remote = "ssh://git@host.invalid/Org/Repo.git";
    const firstRepo = initRepo("one", remote);
    const secondRepo = initRepo("two", remote);
    const registry = new RepositoryIdentityRegistry(db);
    const first = await registry.resolve(firstRepo);
    const second = await registry.resolve(secondRepo);

    expect(second.workspaceId).toBe(first.workspaceId);
    expect(second.repositoryId).not.toBe(first.repositoryId);
  });
});
