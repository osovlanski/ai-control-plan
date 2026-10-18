import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TaskIntent } from "@agent-plane/core";
import type { ResolvedConfig } from "../../config.js";
import type { TaskStore } from "../tasks.js";

const exec = promisify(execFile);

/**
 * Marker files the Composer's intent stage reads, as repo-relative paths in
 * byte order. They are read from the task's BASE COMMIT, never the working
 * tree, so a preview before the worktree exists and a start after it see the
 * same bytes.
 */
export const REPO_SIGNAL_MARKERS = ["Cargo.toml", "go.mod", "package.json", "pnpm-workspace.yaml", "pyproject.toml", "tsconfig.json"] as const;

/** Content cap per marker file, in bytes. Longer files are cut and flagged. */
export const REPO_SIGNAL_MAX_BYTES = 64 * 1024;

const GIT_CALL_TIMEOUT_MS = 5_000;
const GIT_TOTAL_TIMEOUT_MS = 15_000;
const GIT_META_MAX_BUFFER = 64 * 1024;

/**
 * Defined locally; S4 switches it to core's identical type. `relPath` is always
 * repo-relative: an absolute path never appears in the output.
 */
export type RepoSignals =
  | { status: "ok"; baseCommit: string; files: Array<{ relPath: string; content: string; truncated: boolean }> }
  | { status: "unavailable"; reason: "no_repository" | "git_unavailable" | "base_unreadable" };

type Unavailable = Extract<RepoSignals, { status: "unavailable" }>["reason"];

class SignalsUnavailable extends Error {
  constructor(readonly reason: Unavailable) { super(reason); }
}

/** `GIT_*` from the caller's environment (GIT_DIR, GIT_INDEX_FILE, ...) must not redirect which repository is read. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_")) env[key] = value;
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
}

interface GitFailure { code?: string | number; killed?: boolean; signal?: string; name?: string }

/** One bounded git call. Argument array only: no shell, so no path or ref is ever interpreted. */
async function git(repo: string, args: string[], signal: AbortSignal, maxBuffer: number): Promise<Buffer> {
  const { stdout } = await exec("git", ["-C", repo, ...args], {
    encoding: "buffer", maxBuffer, timeout: GIT_CALL_TIMEOUT_MS, signal, env: gitEnv(), windowsHide: true,
  });
  return stdout;
}

/** git missing, or too slow to answer: the signals cannot be read at all. */
const isGitUnavailable = (error: unknown): boolean => {
  const e = error as GitFailure;
  return e.code === "ENOENT" || e.code === "EACCES" || e.killed === true || e.name === "AbortError";
};

/**
 * Reads the Composer's marker files from `baseCommit` of the repository at
 * `repoPath` using `git ls-tree` and `git show`. Never opens the working tree.
 * Missing markers are omitted; the result is sorted by `relPath`. Each file is
 * capped at {@link REPO_SIGNAL_MAX_BYTES} bytes (cut on a character boundary,
 * `truncated: true`). Never throws: every failure is a classified `unavailable`.
 *
 * `baseCommit` defaults to the repository's `HEAD` (what `createTaskWorktree`
 * records as the task's base before any commit lands on its branch). The
 * returned `baseCommit` is always the resolved full object name.
 */
export async function readRepoSignals(input: { repoPath?: string | null; baseCommit?: string | null }): Promise<RepoSignals> {
  const repoPath = input.repoPath;
  if (!repoPath) return { status: "unavailable", reason: "no_repository" };
  const ref = input.baseCommit ?? "HEAD";
  // A ref beginning with "-" would be parsed as an option by git.
  if (ref.startsWith("-") || ref.includes("\0")) return { status: "unavailable", reason: "base_unreadable" };

  const deadline = AbortSignal.timeout(GIT_TOTAL_TIMEOUT_MS);
  try {
    try {
      await git(repoPath, ["rev-parse", "--git-dir"], deadline, GIT_META_MAX_BUFFER);
    } catch (error) {
      if (isGitUnavailable(error)) throw new SignalsUnavailable("git_unavailable");
      throw new SignalsUnavailable("no_repository");
    }

    let baseCommit: string;
    try {
      baseCommit = (await git(repoPath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], deadline, GIT_META_MAX_BUFFER)).toString("utf8").trim();
    } catch (error) {
      throw new SignalsUnavailable(isGitUnavailable(error) ? "git_unavailable" : "base_unreadable");
    }
    if (!/^[0-9a-f]{40,64}$/.test(baseCommit)) throw new SignalsUnavailable("base_unreadable");

    // One call finds which markers exist at the commit and what they are.
    let tree: string;
    try {
      tree = (await git(repoPath, ["ls-tree", "-z", "--full-tree", baseCommit, "--", ...REPO_SIGNAL_MARKERS], deadline, GIT_META_MAX_BUFFER)).toString("utf8");
    } catch (error) {
      throw new SignalsUnavailable(isGitUnavailable(error) ? "git_unavailable" : "base_unreadable");
    }
    const present = new Map<string, string>();
    for (const entry of tree.split("\0")) {
      const tab = entry.indexOf("\t");
      if (tab < 0) continue;
      const [mode, type] = entry.slice(0, tab).split(" ");
      const relPath = entry.slice(tab + 1);
      // Regular files only: a symlink or submodule is not a readable marker.
      if (type === "blob" && (mode === "100644" || mode === "100755") && (REPO_SIGNAL_MARKERS as readonly string[]).includes(relPath)) present.set(relPath, mode);
    }

    const files: Array<{ relPath: string; content: string; truncated: boolean }> = [];
    for (const relPath of [...present.keys()].sort()) {
      let raw: Buffer;
      let truncated = false;
      try {
        raw = await git(repoPath, ["show", `${baseCommit}:${relPath}`], deadline, REPO_SIGNAL_MAX_BYTES);
      } catch (error) {
        const failure = error as GitFailure & { stdout?: Buffer };
        // Output past the cap kills git; node hands back the first `maxBuffer` bytes.
        if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" && Buffer.isBuffer(failure.stdout)) {
          raw = failure.stdout;
          truncated = true;
        } else {
          throw new SignalsUnavailable(isGitUnavailable(error) ? "git_unavailable" : "base_unreadable");
        }
      }
      files.push({ relPath, content: decode(raw, truncated), truncated });
    }
    return { status: "ok", baseCommit, files };
  } catch (error) {
    if (error instanceof SignalsUnavailable) return { status: "unavailable", reason: error.reason };
    return { status: "unavailable", reason: isGitUnavailable(error) ? "git_unavailable" : "base_unreadable" };
  }
}

/** A cut file may end inside a multi-byte character; drop the partial one rather than emit a replacement character. */
function decode(raw: Buffer, truncated: boolean): string {
  let end = raw.length;
  if (truncated) {
    // Walk back over a trailing partial UTF-8 sequence (a lead byte whose continuation bytes were cut off).
    let i = end - 1;
    let continuation = 0;
    while (i >= 0 && continuation < 3 && (raw[i]! & 0xc0) === 0x80) { i -= 1; continuation += 1; }
    if (i >= 0) {
      const lead = raw[i]!;
      const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
      if (need > 1 && end - i < need) end = i;
    }
  }
  return raw.subarray(0, end).toString("utf8");
}

/**
 * The signals for a stored task: its repository from the durable intent, its
 * base commit from `tasks.base_ref` (set when the worktree is created; before
 * that, the repository's HEAD, which is what the worktree will branch from). A
 * repository outside the workspace allowlist is reported as `no_repository`:
 * the Composer never reads a repository the router would refuse.
 */
export async function repoSignalsForTask(
  deps: { tasks: TaskStore; config: Pick<ResolvedConfig, "repoAllowlist"> },
  taskId: string,
): Promise<RepoSignals> {
  const row = deps.tasks.get(taskId);
  if (!row) throw new Error(`Unknown task ${taskId}`);
  const repository = (JSON.parse(row.intent_json) as TaskIntent).repository;
  if (!repository) return { status: "unavailable", reason: "no_repository" };
  const allowed = deps.config.repoAllowlist.some((p) => repository.path === p || repository.path.startsWith(`${p}/`));
  if (!allowed) return { status: "unavailable", reason: "no_repository" };
  return readRepoSignals({ repoPath: repository.path, baseCommit: row.base_ref });
}
