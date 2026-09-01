/**
 * Phase 2 — WorkspaceAuthority: canonical roots + allowlist re-validation,
 * symlink-escape containment, session-owned write paths, and the reduced-env
 * cwd-pinned command boundary (§3, H-I11).
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WorkspaceAuthority,
  WorkspaceError,
} from "../../src/modules/harness/workspace-authority.js";

let root: string;
let repo: string;
let outside: string;
let worktreeRoot: string;
let worktree: string;
let authority: WorkspaceAuthority;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "harness-wa-")));
  repo = join(root, "repo");
  outside = join(root, "outside");
  worktreeRoot = join(root, "worktrees");
  worktree = join(worktreeRoot, "session-1");
  for (const d of [repo, outside, worktreeRoot, worktree]) mkdirSync(d, { recursive: true });
  authority = new WorkspaceAuthority({ repoAllowlist: [repo], worktreeRoot });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("validateRoots", () => {
  it("accepts an allowlisted repo with a worktree under the worktree root", () => {
    const roots = authority.validateRoots({ repoPath: repo, worktreePath: worktree });
    expect(roots.repoPath).toBe(realpathSync(repo));
    expect(roots.worktreePath).toBe(realpathSync(worktree));
  });

  it("rejects a repo outside the instance allowlist", () => {
    expect(() => authority.validateRoots({ repoPath: outside, worktreePath: worktree })).toThrow(
      WorkspaceError,
    );
    try {
      authority.validateRoots({ repoPath: outside, worktreePath: worktree });
    } catch (e) {
      expect((e as WorkspaceError).check).toBe("repo-allowlist");
    }
  });

  it("rejects a worktree that resolves outside the worktree root and the repo", () => {
    try {
      authority.validateRoots({ repoPath: repo, worktreePath: outside });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as WorkspaceError).check).toBe("worktree-containment");
    }
  });

  it("rejects a worktree path that is a symlink escaping the root", () => {
    const evil = join(worktreeRoot, "evil");
    symlinkSync(outside, evil);
    try {
      authority.validateRoots({ repoPath: repo, worktreePath: evil });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as WorkspaceError).check).toBe("worktree-containment");
    }
  });
});

describe("resolveWrite", () => {
  it("resolves a relative path inside the worktree", () => {
    expect(authority.resolveWrite(worktree, "src/a.ts")).toBe(join(realpathSync(worktree), "src/a.ts"));
  });

  it("rejects an absolute path", () => {
    try {
      authority.resolveWrite(worktree, "/etc/passwd");
      throw new Error("no throw");
    } catch (e) {
      expect((e as WorkspaceError).check).toBe("write-absolute");
    }
  });

  it("rejects a ../ escape", () => {
    try {
      authority.resolveWrite(worktree, "../session-2/x");
      throw new Error("no throw");
    } catch (e) {
      expect((e as WorkspaceError).check).toBe("write-escape");
    }
  });

  it("rejects a write that resolves via a symlink out of the worktree", () => {
    symlinkSync(outside, join(worktree, "link"));
    try {
      authority.resolveWrite(worktree, "link/file.txt");
      throw new Error("no throw");
    } catch (e) {
      expect((e as WorkspaceError).check).toBe("write-symlink-escape");
    }
  });
});

describe("artifactExists", () => {
  it("reports a plain in-worktree file as present and a missing one as absent", () => {
    writeFileSync(join(worktree, "built.txt"), "ok");
    expect(authority.artifactExists(worktree, "built.txt")).toBe(true);
    expect(authority.artifactExists(worktree, "nope.txt")).toBe(false);
    expect(authority.artifactExists(worktree, "dist")).toBe(false);
    mkdirSync(join(worktree, "dist"));
    expect(authority.artifactExists(worktree, "dist")).toBe(true); // a directory counts
  });

  it("follows an in-worktree symlink (present) but a dangling one reads as missing", () => {
    writeFileSync(join(worktree, "real.txt"), "ok");
    symlinkSync(join(worktree, "real.txt"), join(worktree, "link.txt"));
    symlinkSync(join(worktree, "gone.txt"), join(worktree, "dangling.txt"));
    expect(authority.artifactExists(worktree, "link.txt")).toBe(true);
    expect(authority.artifactExists(worktree, "dangling.txt")).toBe(false);
  });

  it("rejects an absolute path, a ../ escape and a symlink that escapes the worktree", () => {
    expect(() => authority.artifactExists(worktree, "/etc/passwd")).toThrow(WorkspaceError);
    expect(() => authority.artifactExists(worktree, "../session-2/x")).toThrow(WorkspaceError);
    symlinkSync(outside, join(worktree, "escape"));
    try {
      authority.artifactExists(worktree, "escape/secret");
      throw new Error("no throw");
    } catch (e) {
      expect((e as WorkspaceError).check).toBe("artifact-symlink-escape");
    }
  });
});

describe("runCommand", () => {
  it("runs a declared command with cwd pinned to the session worktree", async () => {
    const r = await authority.runCommand({ command: "pwd", worktreePath: worktree, timeoutMs: 5000 });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe(realpathSync(worktree));
  });

  it("rebuilds env from an allowlist and repoints HOME at the worktree", async () => {
    process.env.HARNESS_TEST_SECRET_TOKEN = "leaked";
    try {
      const r = await authority.runCommand({
        command: 'echo "PATH=[$PATH]"; echo "SECRET=[$HARNESS_TEST_SECRET_TOKEN]"; echo "HOME=[$HOME]"',
        worktreePath: worktree,
        timeoutMs: 5000,
      });
      expect(r.stdout).toMatch(/PATH=\[.+\]/); // PATH is on the allowlist
      expect(r.stdout).toContain("SECRET=[]"); // ambient token is not
      expect(r.stdout).toContain(`HOME=[${realpathSync(worktree)}]`); // no ambient HOME → no dotfile creds
    } finally {
      delete process.env.HARNESS_TEST_SECRET_TOKEN;
    }
  });

  it("refuses a dangerous env name even if it is on the allowlist", () => {
    const evil = new WorkspaceAuthority({ repoAllowlist: [repo], worktreeRoot, envAllowlist: ["LD_PRELOAD"] });
    expect(() => evil.reducedEnv()).toThrow(WorkspaceError);
    const evil2 = new WorkspaceAuthority({ repoAllowlist: [repo], worktreeRoot, envAllowlist: ["MY_API_KEY"] });
    expect(() => evil2.reducedEnv()).toThrow(WorkspaceError);
  });

  it("kills a command that overruns its wall-clock budget", async () => {
    const r = await authority.runCommand({ command: "sleep 5", worktreePath: worktree, timeoutMs: 150 });
    expect(r.timedOut).toBe(true);
  });

  it("caps combined output by BYTE size", async () => {
    const r = await authority.runCommand({
      command: "for i in $(seq 1 2000); do echo aaaaaaaaaaaaaaaaaaaa; done; echo err 1>&2",
      worktreePath: worktree,
      timeoutMs: 5000,
      maxOutputBytes: 256,
    });
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.stdout) + Buffer.byteLength(r.stderr)).toBeLessThanOrEqual(256);
  });

  it("rejects a worktree outside the worktree root", async () => {
    await expect(
      authority.runCommand({ command: "pwd", worktreePath: outside, timeoutMs: 5000 }),
    ).rejects.toThrow(WorkspaceError);
  });

  it("rejects a cwd that escapes the session worktree", async () => {
    await expect(
      authority.runCommand({ command: "pwd", worktreePath: worktree, cwd: outside, timeoutMs: 5000 }),
    ).rejects.toThrow(WorkspaceError);
  });
});

describe("writeOwnedFile", () => {
  it("writes inside the worktree", () => {
    const p = authority.writeOwnedFile(worktree, "notes/a.txt", "hi");
    expect(p).toBe(join(realpathSync(worktree), "notes/a.txt"));
  });

  it("refuses to follow a symlink swapped in at the final component", () => {
    symlinkSync(join(outside, "pwned"), join(worktree, "target"));
    expect(() => authority.writeOwnedFile(worktree, "target", "x")).toThrow(WorkspaceError);
  });
});
