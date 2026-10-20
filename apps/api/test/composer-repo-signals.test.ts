/**
 * M2 Composer S3: marker files are read from the task's BASE COMMIT with git, bounded,
 * relative, and never from the working tree. Real repositories in the OS temp dir.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db/index.js";
import { REPO_SIGNAL_MARKERS, REPO_SIGNAL_MAX_BYTES, readRepoSignals, repoSignalsForTask } from "../src/modules/composer/repo-signals.js";
import { TaskStore } from "../src/modules/tasks.js";

let root: string;
let repo: string;

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe", env: gitEnv }).toString().trim();
const commit = (message: string) => { git(repo, "add", "-A"); git(repo, "commit", "-qm", message); return git(repo, "rev-parse", "HEAD"); };
const write = (rel: string, content: string | Buffer) => { mkdirSync(join(repo, rel, ".."), { recursive: true }); writeFileSync(join(repo, rel), content); };

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "composer-signals-")));
  repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "pipe" });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const ok = (r: Awaited<ReturnType<typeof readRepoSignals>>) => {
  if (r.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r;
};

describe("readRepoSignals", () => {
  it("reads the base commit, not a dirty working tree", async () => {
    write("package.json", '{"name":"at-base","dependencies":{"typescript":"^5"}}\n');
    write("tsconfig.json", '{"compilerOptions":{}}\n');
    const base = commit("base");
    // Uncommitted edits, a deleted marker, and a marker that exists only on disk.
    write("package.json", '{"name":"DIRTY"}\n');
    rmSync(join(repo, "tsconfig.json"));
    write("go.mod", "module dirty\n");
    expect(git(repo, "status", "--porcelain")).not.toBe("");

    const r = ok(await readRepoSignals({ repoPath: repo, baseCommit: base }));
    expect(r.baseCommit).toBe(base);
    expect(r.files).toEqual([
      { relPath: "package.json", content: '{"name":"at-base","dependencies":{"typescript":"^5"}}\n', truncated: false },
      { relPath: "tsconfig.json", content: '{"compilerOptions":{}}\n', truncated: false },
    ]);
  });

  it("reads the named commit even when a later commit changed the file, and defaults to HEAD", async () => {
    write("package.json", '{"v":1}\n');
    const first = commit("one");
    write("package.json", '{"v":2}\n');
    const second = commit("two");

    expect(ok(await readRepoSignals({ repoPath: repo, baseCommit: first })).files[0]!.content).toBe('{"v":1}\n');
    const head = ok(await readRepoSignals({ repoPath: repo }));
    expect(head.baseCommit).toBe(second);
    expect(head.files[0]!.content).toBe('{"v":2}\n');
    // A short or symbolic ref resolves to the full object name.
    expect(ok(await readRepoSignals({ repoPath: repo, baseCommit: "HEAD~1" })).baseCommit).toBe(first);
  });

  it("omits absent markers, sorts by relPath, and never emits an absolute path", async () => {
    for (const name of ["pyproject.toml", "Cargo.toml", "pnpm-workspace.yaml", "go.mod", "package.json", "tsconfig.json"]) write(name, `# ${name}\n`);
    write("README.md", "not a marker\n");
    write("src/package.json", "{}\n"); // a nested marker is not the root marker
    commit("all markers");
    const all = ok(await readRepoSignals({ repoPath: repo }));
    expect(all.files.map((f) => f.relPath)).toEqual([...REPO_SIGNAL_MARKERS]);
    expect(all.files.map((f) => f.relPath)).toEqual([...all.files.map((f) => f.relPath)].sort());

    rmSync(join(repo, "Cargo.toml"));
    rmSync(join(repo, "go.mod"));
    commit("remove two");
    const some = ok(await readRepoSignals({ repoPath: repo }));
    expect(some.files.map((f) => f.relPath)).toEqual(["package.json", "pnpm-workspace.yaml", "pyproject.toml", "tsconfig.json"]);

    const serialized = JSON.stringify(some);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain(tmpdir());
    for (const f of some.files) expect(f.relPath.startsWith("/")).toBe(false);
  });

  it("is ok with no files when the commit has no marker", async () => {
    write("README.md", "hello\n");
    const base = commit("readme only");
    expect(await readRepoSignals({ repoPath: repo, baseCommit: base })).toEqual({ status: "ok", baseCommit: base, files: [] });
  });

  it("caps each file at 64 KiB and flags the cut; a file of exactly the cap is not truncated", async () => {
    expect(REPO_SIGNAL_MAX_BYTES).toBe(65536);
    write("package.json", "a".repeat(REPO_SIGNAL_MAX_BYTES));
    write("tsconfig.json", "b".repeat(REPO_SIGNAL_MAX_BYTES + 1));
    write("go.mod", "c".repeat(REPO_SIGNAL_MAX_BYTES * 4));
    commit("sizes");
    const r = ok(await readRepoSignals({ repoPath: repo }));
    const by = Object.fromEntries(r.files.map((f) => [f.relPath, f]));
    expect(by["package.json"]).toMatchObject({ truncated: false });
    expect(by["package.json"]!.content).toHaveLength(REPO_SIGNAL_MAX_BYTES);
    expect(by["tsconfig.json"]).toMatchObject({ truncated: true });
    expect(by["tsconfig.json"]!.content).toBe("b".repeat(REPO_SIGNAL_MAX_BYTES));
    expect(by["go.mod"]).toMatchObject({ truncated: true });
    expect(Buffer.byteLength(by["go.mod"]!.content)).toBe(REPO_SIGNAL_MAX_BYTES);
  });

  it("never splits a multi-byte character when it cuts", async () => {
    // 3-byte characters: the cap lands mid-character (65536 = 3 * 21845 + 1).
    write("package.json", "€".repeat(30_000));
    commit("multibyte");
    const file = ok(await readRepoSignals({ repoPath: repo })).files[0]!;
    expect(file.truncated).toBe(true);
    expect(file.content).not.toContain("�");
    expect(file.content).toBe("€".repeat(21_845));
    expect(Buffer.byteLength(file.content)).toBeLessThanOrEqual(REPO_SIGNAL_MAX_BYTES);
  });

  it("reads the repository root markers when given a subdirectory of the repository", async () => {
    write("package.json", '{"root":true}\n');
    write("packages/app/package.json", '{"root":false}\n');
    commit("monorepo");
    const r = ok(await readRepoSignals({ repoPath: join(repo, "packages", "app") }));
    expect(r.files).toEqual([{ relPath: "package.json", content: '{"root":true}\n', truncated: false }]);
  });

  it("skips a marker that is a symlink or a directory instead of following it", async () => {
    write("secret-target.txt", "FAKE-token-not-real\n");
    symlinkSync("secret-target.txt", join(repo, "package.json"));
    write("go.mod/inner.txt", "a directory named like a marker\n");
    write("tsconfig.json", "{}\n");
    commit("odd markers");
    const r = ok(await readRepoSignals({ repoPath: repo }));
    expect(r.files.map((f) => f.relPath)).toEqual(["tsconfig.json"]);
    expect(JSON.stringify(r)).not.toContain("FAKE-token");
  });

  describe("unavailable", () => {
    it("reports no_repository for no path, a plain directory, and a missing directory", async () => {
      const plain = join(root, "plain");
      mkdirSync(plain);
      writeFileSync(join(plain, "package.json"), "{}\n");
      for (const repoPath of [undefined, null, "", plain, join(root, "does-not-exist")]) {
        expect(await readRepoSignals({ repoPath })).toEqual({ status: "unavailable", reason: "no_repository" });
      }
    });

    it("reports base_unreadable for a commit that does not exist, a non-commit, an option-shaped ref, and an empty repository", async () => {
      // Empty repository: HEAD resolves to nothing.
      expect(await readRepoSignals({ repoPath: repo })).toEqual({ status: "unavailable", reason: "base_unreadable" });

      write("package.json", "{}\n");
      commit("one");
      for (const baseCommit of ["0".repeat(40), "deadbeef", "no-such-branch", "--output=/dev/null", "-h", "HEAD\0x"]) {
        expect(await readRepoSignals({ repoPath: repo, baseCommit })).toEqual({ status: "unavailable", reason: "base_unreadable" });
      }
      // A tree object is not a commit.
      expect(await readRepoSignals({ repoPath: repo, baseCommit: git(repo, "rev-parse", "HEAD^{tree}") })).toEqual({ status: "unavailable", reason: "base_unreadable" });
    });

    it("never interprets a ref as shell: a hostile ref creates nothing", async () => {
      write("package.json", "{}\n");
      commit("one");
      const marker = join(root, "pwned");
      const r = await readRepoSignals({ repoPath: repo, baseCommit: `HEAD; touch ${marker}` });
      expect(r).toEqual({ status: "unavailable", reason: "base_unreadable" });
      expect(existsSync(marker)).toBe(false);
    });

    it("reports git_unavailable when git cannot be run", async () => {
      write("package.json", "{}\n");
      commit("one");
      const path = process.env.PATH;
      process.env.PATH = join(root, "no-bin");
      try {
        expect(await readRepoSignals({ repoPath: repo })).toEqual({ status: "unavailable", reason: "git_unavailable" });
      } finally {
        process.env.PATH = path;
      }
    });

    it("ignores GIT_DIR in the caller's environment", async () => {
      write("package.json", '{"which":"repo"}\n');
      commit("one");
      const other = join(root, "other");
      execFileSync("git", ["init", "-q", "-b", "main", other], { stdio: "pipe" });
      process.env.GIT_DIR = join(other, ".git");
      try {
        expect(ok(await readRepoSignals({ repoPath: repo })).files[0]!.content).toBe('{"which":"repo"}\n');
      } finally {
        delete process.env.GIT_DIR;
      }
    });
  });
});

describe("repoSignalsForTask", () => {
  let db: Db;
  let tasks: TaskStore;
  beforeEach(() => {
    db = openDb(join(root, "t.db"));
    tasks = new TaskStore(db);
  });
  afterEach(() => db.close());

  it("uses the intent's repository and HEAD before a worktree exists, then the recorded base_ref", async () => {
    write("package.json", '{"v":1}\n');
    const first = commit("one");
    const task = tasks.create({ goal: "g", repoPath: repo });
    const config = { repoAllowlist: [repo] };

    const before = ok(await repoSignalsForTask({ tasks, config }, task.taskId));
    expect(before.baseCommit).toBe(first);

    write("package.json", '{"v":2}\n');
    commit("two");
    tasks.setWorktree(task.taskId, join(root, "wt"), `task/${task.taskId}`, first);
    const after = ok(await repoSignalsForTask({ tasks, config }, task.taskId));
    expect(after.baseCommit).toBe(first);
    expect(after.files[0]!.content).toBe('{"v":1}\n');
  });

  it("reports no_repository for a task without a repository and for one outside the allowlist", async () => {
    write("package.json", "{}\n");
    commit("one");
    const bare = tasks.create({ goal: "no repo" });
    const outside = tasks.create({ goal: "outside", repoPath: repo });
    expect(await repoSignalsForTask({ tasks, config: { repoAllowlist: [repo] } }, bare.taskId)).toEqual({ status: "unavailable", reason: "no_repository" });
    expect(await repoSignalsForTask({ tasks, config: { repoAllowlist: [join(root, "elsewhere")] } }, outside.taskId)).toEqual({ status: "unavailable", reason: "no_repository" });
  });

  it("throws for an unknown task, as routeTask does", async () => {
    await expect(repoSignalsForTask({ tasks, config: { repoAllowlist: [] } }, "AG-nope")).rejects.toThrow(/Unknown task/);
  });
});
