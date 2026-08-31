/**
 * WorkspaceAuthority — the single Harness-side filesystem/process boundary (§3).
 *
 * Nothing else in the Harness touches paths or spawns processes. This class:
 *  - re-validates repo roots against the instance allowlist (canonicalized) — the
 *    Harness is a trust boundary, not a trusting callee;
 *  - contains generated writes to session-owned paths and does the write itself
 *    with O_NOFOLLOW so a symlink swapped in after the check cannot redirect it;
 *  - runs declared verification commands as its own child process: cwd pinned
 *    INSIDE the validated session worktree, environment rebuilt from a strict
 *    allowlist minus a dangerous-name blocklist (no provider credentials; HOME
 *    repointed at the worktree so dotfile creds are unreachable), output and
 *    wall-clock capped, no dynamic interpolation of untrusted strings.
 *
 * Scope honesty (§3): this governs HARNESS-owned activity only. The provider
 * process the adapter launches is not confined here — that is an isolation-tier
 * fact reported on the result, never an implied guarantee (H-I11).
 *
 * ponytail: the timeout path kills the child's process group and resolves; it
 * does not reap a deeper descendant tree that escaped its group. Upgrade to a
 * cgroup/job-object confinement with the remote-runner boundary if it matters.
 */
import { spawn } from "node:child_process";
import { closeSync, constants as fsConstants, mkdirSync, openSync, realpathSync, writeSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";

export class WorkspaceError extends Error {
  constructor(
    readonly check: string,
    message: string,
  ) {
    super(`workspace authority rejected (${check}): ${message}`);
    this.name = "WorkspaceError";
  }
}

export interface CanonicalRoots {
  repoPath: string;
  worktreePath: string;
}

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

const DEFAULT_ENV_ALLOWLIST = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM"] as const;
/** Names that must never reach a child even if an operator adds them to the allowlist. */
const DANGEROUS_ENV = new Set([
  "NODE_OPTIONS",
  "BASH_ENV",
  "ENV",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "SSH_AUTH_SOCK",
  "GIT_SSH_COMMAND",
  "PYTHONSTARTUP",
  "PERL5OPT",
]);
const SECRET_NAME = /(?:^|[_-])(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)(?:$|[_-])/i;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

export class WorkspaceAuthority {
  constructor(
    private opts: {
      repoAllowlist: string[];
      /** Canonical parent dir every session worktree must resolve under. */
      worktreeRoot: string;
      /** Extra env var names allowed through to verification commands (blocklist still applies). */
      envAllowlist?: string[];
    },
  ) {}

  /**
   * Re-validate + canonicalize the repo/worktree roots. A rejection here is
   * `FAILED(workspace)` before any adapter call, with the failed check named.
   */
  validateRoots(input: { repoPath: string; worktreePath: string }): CanonicalRoots {
    const repoPath = this.canonical(input.repoPath, "repo-realpath");
    if (!this.allowed(repoPath)) {
      throw new WorkspaceError("repo-allowlist", `${repoPath} is not in the instance repo allowlist`);
    }
    const worktreePath = this.canonical(input.worktreePath, "worktree-realpath");
    const root = this.canonical(this.opts.worktreeRoot, "worktree-root-realpath");
    if (!contains(root, worktreePath) && !contains(repoPath, worktreePath) && worktreePath !== repoPath) {
      throw new WorkspaceError(
        "worktree-containment",
        `${worktreePath} resolves outside both the worktree root and the repo`,
      );
    }
    return { repoPath, worktreePath };
  }

  /**
   * Resolve a path for a generated write inside `worktreePath`. `..` escapes,
   * absolute paths and symlink escapes on the existing prefix are rejected.
   * This returns a string for inspection; use {@link writeOwnedFile} to actually
   * write (it re-checks and opens with O_NOFOLLOW to close the TOCTOU window).
   */
  resolveWrite(worktreePath: string, relative: string): string {
    if (isAbsolute(relative)) {
      throw new WorkspaceError("write-absolute", `${relative} must be relative to the session worktree`);
    }
    const canonicalRoot = this.canonical(worktreePath, "worktree-realpath");
    const target = resolve(canonicalRoot, relative);
    if (!contains(canonicalRoot, target) && target !== canonicalRoot) {
      throw new WorkspaceError("write-escape", `${relative} escapes the session worktree`);
    }
    const existingReal = this.deepestRealpath(target);
    if (!contains(canonicalRoot, existingReal) && existingReal !== canonicalRoot) {
      throw new WorkspaceError("write-symlink-escape", `${relative} resolves via a symlink outside the worktree`);
    }
    return target;
  }

  /**
   * Create + write a session-owned file. `O_EXCL | O_NOFOLLOW` on the final
   * component means an existing file (owned or not) and a symlink swapped in
   * after {@link resolveWrite} both fail the open instead of redirecting it.
   */
  writeOwnedFile(worktreePath: string, relative: string, contents: string): string {
    const target = this.resolveWrite(worktreePath, relative);
    mkdirSync(dirname(target), { recursive: true });
    let fd: number;
    try {
      fd = openSync(
        target,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
        0o600,
      );
    } catch (err) {
      throw new WorkspaceError("write-open", `${relative}: ${(err as Error).message}`);
    }
    try {
      writeSync(fd, contents);
    } finally {
      closeSync(fd);
    }
    return target;
  }

  /**
   * Run a declared verification command as a child of the authority. The command
   * string is operator-declared (Control Plane built the request); no provider
   * output is interpolated into it.
   */
  async runCommand(spec: {
    command: string;
    /** The validated session worktree (from {@link validateRoots}). */
    worktreePath: string;
    /** Working dir — defaults to `worktreePath`; if given, must resolve inside it. */
    cwd?: string;
    timeoutMs: number;
    maxOutputBytes?: number;
  }): Promise<CommandResult> {
    const worktree = this.canonical(spec.worktreePath, "command-worktree-realpath");
    if (!contains(this.canonical(this.opts.worktreeRoot, "worktree-root-realpath"), worktree) && worktree !== this.canonical(this.opts.worktreeRoot, "worktree-root-realpath")) {
      throw new WorkspaceError("command-worktree", `${worktree} is not under the worktree root`);
    }
    const cwd = spec.cwd ? this.canonical(spec.cwd, "command-cwd-realpath") : worktree;
    if (!contains(worktree, cwd) && cwd !== worktree) {
      throw new WorkspaceError("command-cwd", `${cwd} is not inside the session worktree`);
    }
    const cap = spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const env = this.reducedEnv();
    env.HOME = worktree; // no ambient HOME — provider dotfiles must be unreachable

    return new Promise((resolveResult) => {
      const child = spawn(spec.command, {
        cwd,
        env,
        shell: true,
        detached: true, // own process group so a shell-spawned grandchild dies too
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let bytes = 0;
      let truncated = false;
      let timedOut = false;
      let settled = false;
      const clamp = (buf: string, chunk: Buffer): string => {
        const room = cap - bytes;
        if (room <= 0) {
          truncated = true;
          return buf;
        }
        if (chunk.byteLength > room) {
          truncated = true;
          bytes = cap;
          return buf + chunk.subarray(0, room).toString("utf8");
        }
        bytes += chunk.byteLength;
        return buf + chunk.toString("utf8");
      };
      child.stdout.on("data", (c: Buffer) => (stdout = clamp(stdout, c)));
      child.stderr.on("data", (c: Buffer) => (stderr = clamp(stderr, c)));

      const finish = (exitCode: number | null, extraStderr = ""): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveResult({ exitCode, stdout, stderr: stderr + extraStderr, timedOut, truncated });
      };

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
        finish(null);
      }, spec.timeoutMs);

      child.on("close", (code) => finish(code));
      child.on("error", (err) => finish(null, String((err as Error).message)));
    });
  }

  /** The env a verification command sees — allowlist minus the dangerous-name blocklist. */
  reducedEnv(): Record<string, string> {
    const allow = new Set<string>([...DEFAULT_ENV_ALLOWLIST, ...(this.opts.envAllowlist ?? [])]);
    const env: Record<string, string> = {};
    for (const key of allow) {
      if (DANGEROUS_ENV.has(key) || SECRET_NAME.test(key)) {
        throw new WorkspaceError("command-env-name", `refusing dangerous/secret-shaped env var ${key}`);
      }
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    return env;
  }

  private allowed(repoPath: string): boolean {
    return this.opts.repoAllowlist.some((entry) => {
      let allowed = entry;
      try {
        allowed = realpathSync(entry);
      } catch {
        // Unresolvable allowlist entry — compare the raw string as a fallback.
      }
      return repoPath === allowed || contains(allowed, repoPath);
    });
  }

  private canonical(path: string, check: string): string {
    try {
      return realpathSync(path);
    } catch (err) {
      throw new WorkspaceError(check, `${path} could not be resolved: ${(err as Error).message}`);
    }
  }

  private deepestRealpath(target: string): string {
    let probe = target;
    for (;;) {
      try {
        return realpathSync(probe);
      } catch {
        const parent = resolve(probe, "..");
        if (parent === probe) return probe;
        probe = parent;
      }
    }
  }
}

function contains(root: string, child: string): boolean {
  return child.startsWith(root.endsWith(sep) ? root : root + sep);
}
