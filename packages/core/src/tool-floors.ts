/**
 * M16 K19i — deterministic floors DECIDE the tool gate (plan §5 K19i).
 *
 * K19h measured the judge as a second lock and found it breaks near the line:
 * one plausible sentence removed its prompt on 13 of the 33 actions only it
 * prompted on, and a benign control flipped some too. The owner decided the
 * judge leaves the hot path. What replaces it is this file: a fixed set of
 * rules over the RAW action, each naming a fact an operator can check.
 *
 * Rules for every floor (the K19i contract):
 *
 * - **Pure and deterministic.** No model, no I/O, no clock. The same action
 *   always gets the same hits.
 * - **A floor adds a prompt, never removes one.** `resolveFloorGate` below
 *   reads a rules deny and the read-only ceiling FIRST, exactly as before.
 * - **Fail toward more supervision.** Anything the parser cannot read with
 *   confidence (unbalanced quotes, a command name from a variable, inline
 *   interpreter code, a tool whose input no floor understands) is an `opaque`
 *   hit, so it prompts. A floor that silently passes is worse than one that
 *   over-prompts.
 * - **Reasons are fixed sentences.** Never matched text, so a verdict reason
 *   cannot carry a secret, and never a probability.
 * - **Linear time.** The command is attacker-sized. The shell reader is a
 *   single forward scan with a nesting cap; the few regexes have no nested
 *   quantifiers. `packages/core/test/tool-floors.test.ts` times each on
 *   hostile input (K19g once shipped a pattern that took 10.8 s).
 *
 * Deliberately NOT floored, because each is recoverable or read-only and a
 * prompt there is the fatigue §8 names: `rm` of one file, `rm -r` without
 * `-f`, `git reset --soft`, `git commit --amend`, `git rebase`, `mv` inside
 * the worktree, `curl` GET, `git push` of a branch to a configured remote.
 */
import type { PermissionPolicy } from "./adapter.js";
import type { ToolGateObservation, ToolGateVerdict } from "./decision.js";
import { toolGateFloors } from "./decision.js";

export type FloorRule =
  | "opaque"
  | "path-outside-worktree"
  | "write-outside-worktree"
  | "credential-file"
  | "env-dump"
  | "privilege"
  | "pipe-to-shell"
  | "network-pipe"
  | "cloud-upload"
  | "network-write"
  | "file-upload"
  | "new-remote"
  | "remote-delete"
  | "local-ref-destruction"
  | "history-rewrite"
  | "publish"
  | "admin-merge"
  | "infra-destroy"
  | "destructive-sql"
  | "recursive-permission"
  | "recursive-forced-rm"
  | "bulk-delete"
  | "truncate"
  | "process-kill"
  | "dependency"
  | "container-host-mount"
  | "scheduled-job";

/** One plain sentence per rule, written for the operator deciding the prompt. */
export const FLOOR_REASONS: Record<Exclude<FloorRule, "opaque">, string> = {
  "path-outside-worktree": "Names a path outside the task's worktree; check the agent should touch it.",
  "write-outside-worktree": "Writes outside the worktree, where git cannot undo it.",
  "credential-file": "Names a credential file (.env, SSH key, cloud or registry auth); check the agent needs it.",
  "env-dump": "Prints the environment, which can hold API keys and tokens.",
  privilege: "Runs with elevated privileges (sudo, su or doas).",
  "pipe-to-shell": "Feeds text into a shell or interpreter, so whatever arrives is executed unseen.",
  "network-pipe": "Streams data to, or runs commands on, a remote host (nc, socat, ssh or /dev/tcp).",
  "cloud-upload": "Uploads files in bulk to cloud storage.",
  "network-write": "Sends a request with a body or a write method (POST, PUT, PATCH, DELETE) to a network service.",
  "file-upload": "Uploads a local file to a network destination.",
  "new-remote": "Adds a git remote, or pushes to a URL or path that is not a configured remote.",
  "remote-delete": "Deletes a branch, tag, release or repository on a remote.",
  "local-ref-destruction": "Deletes a local branch, tag or stash, or discards uncommitted work.",
  "history-rewrite": "Rewrites or prunes git history beyond what the reflog can undo, or force-pushes.",
  publish: "Publishes a package, image or release.",
  "admin-merge": "Merges a pull request with an admin override of branch protection.",
  "infra-destroy": "Changes or destroys live infrastructure (kubectl delete, terraform apply or destroy, a cloud delete).",
  "destructive-sql": "Runs destructive SQL (DROP, TRUNCATE or DELETE FROM) or wipes a data store.",
  "recursive-permission": "Changes permissions or ownership recursively.",
  "recursive-forced-rm": "Force-deletes recursively; check the target.",
  "bulk-delete": "Deletes files by pattern or by a variable (find -delete, xargs rm, rm with a glob).",
  truncate: "Truncates or overwrites a file's contents.",
  "process-kill": "Stops or kills processes or services.",
  dependency: "Adds a dependency, installs globally, or downloads and runs a remote package.",
  "container-host-mount": "Starts a container with a host mount or host privileges.",
  "scheduled-job": "Installs a cron job or service that keeps running after the task.",
};

export interface FloorHit {
  rule: FloorRule;
  /** A fixed sentence. For `opaque`, it names what could not be read — never the text itself. */
  reason: string;
}

/** Commands above this are not scanned; they prompt as unreadable. Keeps the work bounded. */
export const MAX_FLOOR_COMMAND_CHARS = 64 * 1024;
/** `$(…)`, backticks, subshells and `bash -c` strings nest at most this deep. */
const MAX_DEPTH = 8;
/** More simple commands than this in one action is not something to read; it prompts. */
const MAX_COMMANDS = 1_024;

/* ------------------------------------------------------------------------- *
 * The shell reader — one forward scan, no backtracking
 * ------------------------------------------------------------------------- */

interface Word {
  /** Quote-removed text. `\r\m` and `'r''m'` both read `rm`. */
  text: string;
  /** Contains an expansion (`$X`, `$(…)`, backticks): its value is not known here. */
  dynamic: boolean;
  /** An unquoted `*`, `?` or `[`. */
  glob: boolean;
  quoted: boolean;
  /** Began with `<(` or `>(`. */
  procsub: boolean;
}

interface Cmd {
  words: Word[];
  redirects: Array<{ op: string; target: Word }>;
  pipedIn: boolean;
  pipedOut: boolean;
  /** Heredoc body or here-string. `literal` is false when the shell would expand it. */
  stdin?: { text: string; literal: boolean };
  subshell: boolean;
}

const newCmd = (): Cmd => ({ words: [], redirects: [], pipedIn: false, pipedOut: false, subshell: false });

class ShellReader {
  private i = 0;
  readonly cmds: Cmd[] = [];
  /** Set once; stops the scan. The reason is a fixed phrase. */
  failed?: string;
  /** Non-fatal unreadable parts. */
  readonly opaque: string[] = [];

  constructor(private readonly s: string) {}

  read(depth: number): this {
    this.list(depth, undefined);
    return this;
  }

  private fail(why: string): void {
    this.failed ??= why;
  }

  private list(depth: number, term: ")" | "`" | undefined): void {
    if (depth > MAX_DEPTH) return this.fail(`nested deeper than ${MAX_DEPTH} levels`);
    const s = this.s;
    let cur = newCmd();
    let nextPipedIn = false;
    const heredocs: Array<{ cmd: Cmd; delim: string; strip: boolean; quoted: boolean }> = [];
    const flush = (pipedOut: boolean): boolean => {
      const empty = cur.words.length === 0 && cur.redirects.length === 0 && !cur.subshell && cur.stdin === undefined;
      if (empty) {
        if (pipedOut || nextPipedIn) this.fail("an empty pipeline stage");
        return !empty;
      }
      cur.pipedIn = nextPipedIn;
      cur.pipedOut = pipedOut;
      nextPipedIn = pipedOut;
      this.cmds.push(cur);
      if (this.cmds.length > MAX_COMMANDS) this.fail(`more than ${MAX_COMMANDS} commands`);
      cur = newCmd();
      return true;
    };
    while (!this.failed) {
      if (this.i >= s.length) {
        if (term) return this.fail(term === ")" ? "an unclosed ( or $(" : "an unclosed backtick");
        flush(false);
        return;
      }
      const c = s[this.i]!;
      const next = s[this.i + 1];
      if (c === " " || c === "\t" || c === "\r") {
        this.i += 1;
      } else if (c === "\\" && next === "\n") {
        this.i += 2;
      } else if (c === "\n") {
        flush(false);
        this.i += 1;
        this.readHeredocs(heredocs);
      } else if (c === "#") {
        const nl = s.indexOf("\n", this.i);
        this.i = nl < 0 ? s.length : nl;
      } else if (c === ";") {
        flush(false);
        this.i += next === ";" ? 2 : 1;
      } else if (c === "&" && next === "&") {
        flush(false);
        this.i += 2;
      } else if (c === "&" && next === ">") {
        this.redirect(cur, heredocs, depth);
      } else if (c === "&") {
        flush(false);
        this.i += 1;
      } else if (c === "|" && next === "|") {
        flush(false);
        this.i += 2;
      } else if (c === "|") {
        if (!flush(true)) return;
        this.i += next === "&" ? 2 : 1;
      } else if (c === "(") {
        if (cur.words.length > 0) return this.fail("a ( where a command argument was expected");
        this.i += 1;
        cur.subshell = true;
        this.list(depth + 1, ")");
      } else if (c === ")") {
        if (term !== ")") return this.fail("an unbalanced )");
        this.i += 1;
        flush(false);
        return;
      } else if (c === "`" && term === "`") {
        this.i += 1;
        flush(false);
        return;
      } else if ((c === "<" || c === ">") && next !== "(") {
        this.redirect(cur, heredocs, depth);
      } else if (c >= "0" && c <= "9" && this.fdRedirectAhead()) {
        while (s[this.i]! >= "0" && s[this.i]! <= "9") this.i += 1;
        this.redirect(cur, heredocs, depth);
      } else {
        const w = this.word(depth, term);
        if (w) cur.words.push(w);
      }
    }
  }

  private fdRedirectAhead(): boolean {
    let j = this.i;
    while (j < this.s.length && this.s[j]! >= "0" && this.s[j]! <= "9") j += 1;
    return this.s[j] === "<" || this.s[j] === ">";
  }

  private redirect(cur: Cmd, heredocs: Array<{ cmd: Cmd; delim: string; strip: boolean; quoted: boolean }>, depth: number): void {
    const s = this.s;
    const op = ["&>>", "&>", "<<<", "<<-", "<<", "<>", "<&", ">>", ">|", ">&", "<", ">"].find((o) => s.startsWith(o, this.i))!;
    this.i += op.length;
    while (s[this.i] === " " || s[this.i] === "\t") this.i += 1;
    if ((op === ">&" || op === "<&") && /[0-9-]/.test(s[this.i] ?? "")) {
      while (/[0-9-]/.test(s[this.i] ?? "")) this.i += 1;
      return;
    }
    const w = this.word(depth, undefined);
    if (this.failed) return;
    if (!w) return this.fail("a redirect with no target");
    if (op === "<<" || op === "<<-") heredocs.push({ cmd: cur, delim: w.text, strip: op === "<<-", quoted: w.quoted });
    else if (op === "<<<") cur.stdin = { text: w.text, literal: !w.dynamic };
    else cur.redirects.push({ op, target: w });
  }

  /** Called at a newline: each pending heredoc takes the lines up to its delimiter as data. */
  private readHeredocs(pending: Array<{ cmd: Cmd; delim: string; strip: boolean; quoted: boolean }>): void {
    const s = this.s;
    for (const h of pending.splice(0)) {
      const body: string[] = [];
      while (this.i < s.length) {
        const nl = s.indexOf("\n", this.i);
        const line = s.slice(this.i, nl < 0 ? s.length : nl);
        this.i = nl < 0 ? s.length : nl + 1;
        if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
        body.push(line);
      }
      const text = body.join("\n");
      // An unquoted delimiter expands `$(…)` and backticks in the body — those run.
      const expands = !h.quoted && (text.includes("$(") || text.includes("`"));
      if (expands) this.opaque.push("a heredoc body with command substitution");
      h.cmd.stdin = { text, literal: h.quoted || !text.includes("$") };
    }
  }

  private word(depth: number, term: ")" | "`" | undefined): Word | undefined {
    const s = this.s;
    const w: Word = { text: "", dynamic: false, glob: false, quoted: false, procsub: false };
    const start = this.i;
    while (this.i < s.length && !this.failed) {
      const c = s[this.i]!;
      const next = s[this.i + 1];
      if ((c === "<" || c === ">") && next === "(") {
        if (this.i === start) w.procsub = true;
        this.i += 2;
        w.dynamic = true;
        this.list(depth + 1, ")");
      } else if (" \t\r\n;&|()<>".includes(c)) {
        break;
      } else if (c === "`") {
        if (term === "`") break;
        this.i += 1;
        w.dynamic = true;
        this.list(depth + 1, "`");
      } else if (c === "'") {
        const end = s.indexOf("'", this.i + 1);
        if (end < 0) {
          this.fail("an unbalanced single quote");
          break;
        }
        w.text += s.slice(this.i + 1, end);
        w.quoted = true;
        this.i = end + 1;
      } else if (c === '"') {
        w.quoted = true;
        this.i += 1;
        this.doubleQuoted(w, depth);
      } else if (c === "\\") {
        if (next !== undefined && next !== "\n") w.text += next;
        this.i += 2;
      } else if (c === "$") {
        w.dynamic = true;
        if (next === "(") {
          this.i += 2;
          this.list(depth + 1, ")");
        } else if (next === "'") {
          // ANSI-C quoting: escapes decode at run time, so the value is not known here.
          const end = this.ansiEnd(this.i + 2);
          if (end < 0) {
            this.fail("an unbalanced $' quote");
            break;
          }
          w.text += s.slice(this.i, end + 1);
          this.i = end + 1;
        } else {
          w.text += c;
          this.i += 1;
        }
      } else {
        if (c === "*" || c === "?" || c === "[") w.glob = true;
        w.text += c;
        this.i += 1;
      }
    }
    return this.i > start ? w : undefined;
  }

  private ansiEnd(from: number): number {
    for (let j = from; j < this.s.length; j += 1) {
      if (this.s[j] === "\\") j += 1;
      else if (this.s[j] === "'") return j;
    }
    return -1;
  }

  private doubleQuoted(w: Word, depth: number): void {
    const s = this.s;
    while (!this.failed) {
      if (this.i >= s.length) return this.fail("an unbalanced double quote");
      const c = s[this.i]!;
      const next = s[this.i + 1];
      if (c === '"') {
        this.i += 1;
        return;
      }
      if (c === "\\") {
        if (next !== undefined && '$`"\\\n'.includes(next)) {
          if (next !== "\n") w.text += next;
        } else {
          w.text += c + (next ?? "");
        }
        this.i += 2;
      } else if (c === "$" && next === "(") {
        w.dynamic = true;
        this.i += 2;
        this.list(depth + 1, ")");
      } else if (c === "`") {
        w.dynamic = true;
        this.i += 1;
        this.list(depth + 1, "`");
      } else {
        if (c === "$") w.dynamic = true;
        w.text += c;
        this.i += 1;
      }
    }
  }
}

/* ------------------------------------------------------------------------- *
 * Per-command rules
 * ------------------------------------------------------------------------- */

const RESERVED = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "{", "}", "!", "[[", "]]"]);
const HEADERS = new Set(["for", "case", "select", "function", "esac", "in"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish", "csh", "tcsh"]);
const INTERPRETER = /^(?:python[\d.]*|pypy[\d.]*|node|nodejs|deno|bun|perl|ruby|php|lua|luajit|rscript|osascript|pwsh|powershell|tclsh|irb)$/i;
/** Flags whose next word is inline code, per interpreter family. */
function inlineCodeFlag(name: string, arg: string): boolean {
  const n = name.toLowerCase();
  if (/^(?:python|pypy)/.test(n)) return /^-[A-Za-z]*c$/.test(arg);
  if (n === "node" || n === "nodejs" || n === "bun") return /^(?:-e|-p|--eval|--print)(?:=|$)/.test(arg);
  if (n === "perl") return /^-[A-Za-z]*[eE]$/.test(arg);
  if (n === "php") return arg === "-r";
  if (n === "pwsh" || n === "powershell") return /^-(?:c|command|Command|EncodedCommand|enc)$/.test(arg);
  if (n === "deno") return arg === "eval";
  return /^-[A-Za-z]*e$/.test(arg); // ruby, lua, osascript, Rscript, irb
}
const SYSTEM_BIN = /^\/(?:usr\/(?:local\/)?)?s?bin\/[^/]+$/;
const SQL_CLIENTS = new Set(["sqlite3", "sqlite", "psql", "mysql", "mariadb", "duckdb", "sqlcmd", "clickhouse", "clickhouse-client", "cockroach", "mongosh", "mongo", "redis-cli", "cqlsh"]);
const DESTRUCTIVE_SQL = /\bdrop\s+(?:table|database|schema|keyspace|collection)\b|\btruncate\b|\bdelete\s+from\b|\.drop(?:Database)?\(|\bdeleteMany\(|\bflush(?:all|db)\b/i;
const PATTERN_FIRST = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack", "sed", "awk", "gawk", "jq", "yq"]);
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const KNOWN_FILE_TOOLS = /^(?:read|write|edit|multiedit|notebookedit|notebookread|glob|grep|ls)$/i;
const KNOWN_NO_EFFECT_TOOLS = /^(?:webfetch|websearch|todowrite|todoread|task|agent|exitplanmode|enterplanmode|askuserquestion|bashoutput|skill|slashcommand|toolsearch)$/i;
const SHELL_TOOLS = /^(?:bash|shell|local_shell|exec_command|run_terminal_cmd|terminal)$/i;

/** Options that consume the following word, per wrapper, so the wrapped command is found. */
const WRAPPER_VALUE_OPTS: Record<string, Set<string>> = {
  sudo: new Set(["-u", "-g", "-C", "-p", "-D", "-R", "-T", "-h", "-U", "--user", "--group", "--chdir"]),
  doas: new Set(["-u", "-C"]),
  nice: new Set(["-n", "--adjustment"]),
  ionice: new Set(["-c", "-n", "-p", "--class", "--classdata"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
  exec: new Set(["-a"]),
  xargs: new Set(["-n", "-I", "-P", "-L", "-d", "-E", "-s", "-a", "--max-args", "--max-procs", "--delimiter", "--arg-file"]),
  env: new Set(["-u", "-C", "--unset", "--chdir"]),
  watch: new Set(["-n", "--interval", "-d"]),
};
const WRAPPERS = new Set(["command", "builtin", "exec", "nohup", "time", "nice", "ionice", "stdbuf", "timeout", "unbuffer", "chronic", "xargs", "env", "watch", "sudo", "doas", "pkexec", "run0", "busybox"]);

interface Ctx {
  worktree?: string;
  depth: number;
  hits: FloorHit[];
}

const hit = (ctx: Ctx, rule: Exclude<FloorRule, "opaque">): void => {
  ctx.hits.push({ rule, reason: FLOOR_REASONS[rule] });
};
const opaque = (ctx: Ctx, what: string): void => {
  ctx.hits.push({ rule: "opaque", reason: `The floors cannot read this action (${what}), so it is shown rather than passed.` });
};

const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/** Lexical resolve, no I/O. `~` and `$HOME` are left as a home-relative marker: outside any worktree. */
function outsideWorktree(path: string, worktree: string | undefined): boolean {
  if (path.startsWith("~") || /^\$\{?HOME\b/.test(path)) return true;
  if (!worktree) return true; // no worktree to be inside of: every absolute, home or `..` path is outside
  const absolute = path.startsWith("/");
  if (!absolute && !path.split("/").includes("..")) return false;
  const out: string[] = [];
  for (const part of (absolute ? path : `${worktree}/${path}`).split("/")) {
    if (part === "..") out.pop();
    else if (part !== "." && part !== "") out.push(part);
  }
  const resolved = `/${out.join("/")}`;
  return !(resolved === worktree || resolved.startsWith(`${worktree}/`));
}

const DEV_OK = /^\/dev\/(?:null|stdin|stdout|stderr|tty|fd\/\d+)$/;

function checkPathWord(ctx: Ctx, w: Word): void {
  let text = w.text;
  const eq = /^-{1,2}[\w-]+=/.exec(text);
  if (eq) text = text.slice(eq[0].length);
  if (text.includes("://")) return;
  if (/\/dev\/(?:tcp|udp)\//.test(text)) return hit(ctx, "network-pipe");
  if (DEV_OK.test(text)) return;
  if (!(text.startsWith("/") || text.startsWith("~") || /^\$\{?HOME\b/.test(text) || text.split("/").includes(".."))) return;
  if (outsideWorktree(text, ctx.worktree)) hit(ctx, "path-outside-worktree");
}

/** `-abc` style short clusters and `--long[=v]` options. */
const isOpt = (t: string): boolean => t.startsWith("-") && t !== "-" && t !== "--";
const shortHas = (t: string, letter: string): boolean => /^-[A-Za-z]+$/.test(t) && t.includes(letter);

/** Positional args after skipping options; `valueOpts` consume the next word. */
function positionals(args: Word[], valueOpts: ReadonlySet<string> = new Set()): Word[] {
  const out: Word[] = [];
  for (let k = 0; k < args.length; k += 1) {
    const t = args[k]!.text;
    if (t === "--") {
      out.push(...args.slice(k + 1));
      break;
    }
    if (isOpt(t)) {
      if (valueOpts.has(t)) k += 1;
      continue;
    }
    out.push(args[k]!);
  }
  return out;
}

/** Wrappers and `find -exec` hand the rest of a command back to `analyse`; this bounds the chain. */
const MAX_HOPS = 16;

/**
 * Analyse one simple command. Wrappers (`sudo`, `env`, `xargs`, …) and
 * `find -exec` analyse the wrapped command with `hops + 1`; its words were
 * already path-checked, so only the first call checks them.
 */
function analyse(ctx: Ctx, cmd: Cmd, words: Word[], via: { xargs?: boolean; find?: boolean; hops?: number } = {}): void {
  const hops = via.hops ?? 0;
  if (hops > MAX_HOPS) return opaque(ctx, `more than ${MAX_HOPS} wrapper commands`);
  let k = 0;
  // Leading assignments and reserved words are not the command.
  while (k < words.length) {
    const w = words[k]!;
    if (!w.quoted && RESERVED.has(w.text)) k += 1;
    else if (!w.quoted && HEADERS.has(w.text)) return; // for/case headers name no command; their $(…) was read separately
    else if (/^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/.test(w.text) && !w.text.startsWith("=")) {
      const value = w.text.slice(w.text.indexOf("=") + 1);
      checkPathWord(ctx, { ...w, text: value });
      k += 1;
    } else break;
  }
  const nameWord = words[k];
  if (nameWord?.text === "[[" && !nameWord.quoted) return; // a test expression; any $(…) in it was read separately
  if (!nameWord) {
    // Only redirects (`> file`): that truncates the target.
    if (cmd.redirects.some((r) => r.op === ">" || r.op === ">|" || r.op === "&>")) hit(ctx, "truncate");
    return;
  }
  if (nameWord.dynamic) return opaque(ctx, "the command name comes from a variable or substitution");
  const raw = nameWord.text;
  if (raw.includes("/") && !SYSTEM_BIN.test(raw)) checkPathWord(ctx, nameWord);
  const name = basename(raw);
  const args = words.slice(k + 1);
  const t = args.map((a) => a.text);
  const pos = (valueOpts?: ReadonlySet<string>) => positionals(args, valueOpts);

  if (hops === 0) {
    // A search pattern or sed/awk program is not a path.
    const pattern = PATTERN_FIRST.has(name) && !t.includes("-e") && !t.includes("--regexp") ? pos()[0] : undefined;
    for (const a of args) if (a !== pattern) checkPathWord(ctx, a);
  }

  // Wrappers: find the wrapped command and analyse it.
  if (WRAPPERS.has(name)) {
    if (name === "sudo" || name === "doas" || name === "pkexec" || name === "run0") hit(ctx, "privilege");
    if ((name === "command" || name === "builtin") && (t.includes("-v") || t.includes("-V"))) return;
    const valueOpts = WRAPPER_VALUE_OPTS[name] ?? new Set<string>();
    let j = 0;
    while (j < args.length) {
      const a = args[j]!.text;
      if (a === "--") {
        j += 1;
        break;
      }
      if (name === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) {
        j += 1;
        continue;
      }
      if (name === "env" && (a === "-S" || a === "--split-string")) {
        const str = args[j + 1];
        if (!str || str.dynamic) return opaque(ctx, "env -S with a dynamic string");
        return reparse(ctx, str.text);
      }
      if (!isOpt(a)) break;
      j += valueOpts.has(a) ? 2 : 1;
    }
    if (name === "timeout" && j < args.length) j += 1; // the duration
    const rest = args.slice(j);
    if (rest.length === 0) {
      if (name === "env") hit(ctx, "env-dump");
      return;
    }
    if (name === "watch") {
      if (rest.some((r) => r.dynamic)) return opaque(ctx, "watch with a dynamic command");
      return reparse(ctx, rest.map((r) => r.text).join(" "));
    }
    return analyse(ctx, { ...cmd, pipedIn: cmd.pipedIn && name !== "xargs" }, rest, {
      ...via,
      xargs: via.xargs || name === "xargs",
      hops: hops + 1,
    });
  }

  if (name === "su") {
    hit(ctx, "privilege");
    const c = t.indexOf("-c");
    if (c >= 0 && args[c + 1]) return args[c + 1]!.dynamic ? opaque(ctx, "su -c with a dynamic string") : reparse(ctx, args[c + 1]!.text);
    return;
  }

  // Shells and interpreters: the code they run is text, so read it or refuse to pass it.
  if (SHELLS.has(name) || name === "eval" || name === "source" || name === ".") return shellLike(ctx, cmd, name, args);
  if (INTERPRETER.test(name)) return interpreter(ctx, cmd, name, args);

  if (name === "find") return find(ctx, cmd, args, hops);
  if (name === "git") return git(ctx, args);

  const p = pos();
  const p0 = p[0]?.text;
  switch (name) {
    case "printenv":
      return hit(ctx, "env-dump");
    case "export":
    case "set":
      if (args.length === 0 || t.every((a) => a === "-p")) hit(ctx, "env-dump");
      return;
    case "declare":
    case "typeset":
      if (p.length === 0 && t.some((a) => /^-[a-zA-Z]*[px]/.test(a))) hit(ctx, "env-dump");
      return;
    case "compgen":
      if (t.includes("-v") || t.includes("-e")) hit(ctx, "env-dump");
      return;
    case "nc":
    case "ncat":
    case "netcat":
    case "telnet":
      if (cmd.pipedIn || cmd.stdin || cmd.redirects.some((r) => r.op === "<") || t.includes("-e") || t.includes("-c")) hit(ctx, "network-pipe");
      return;
    case "socat":
    case "ssh":
      return hit(ctx, "network-pipe");
    case "openssl":
      if (p0 === "s_client") hit(ctx, "network-pipe");
      return;
    case "curl":
      return curl(ctx, args);
    case "wget":
      if (t.some((a) => /^--(?:post-data|post-file|body-data|body-file)\b/.test(a))) hit(ctx, "network-write");
      if (t.some((a) => /^--method=(?:POST|PUT|PATCH|DELETE)$/i.test(a))) hit(ctx, "network-write");
      return;
    case "http":
    case "https":
    case "xh":
      if (p0 && WRITE_METHODS.has(p0.toUpperCase())) hit(ctx, "network-write");
      if (t.includes("--form") || t.includes("-f")) hit(ctx, "network-write");
      return;
    case "gh":
      return gh(ctx, args);
    case "aws":
      return aws(ctx, args);
    case "gsutil":
    case "gcloud":
      return gcloudLike(ctx, name, args);
    case "rclone":
      if (p0 && /^(?:copy|sync|move|copyto|moveto|bisync)$/.test(p0)) {
        const dest = p[p.length - 1]?.text ?? "";
        if (/^[\w-]+:/.test(dest)) hit(ctx, "cloud-upload");
      }
      if (p0 && /^(?:delete|purge|deletefile|rmdir|rmdirs)$/.test(p0)) hit(ctx, "infra-destroy");
      return;
    case "az":
      if (t.includes("storage") && t.some((a) => /^(?:upload|upload-batch|sync)$/.test(a))) hit(ctx, "cloud-upload");
      if (t.includes("delete")) hit(ctx, "infra-destroy");
      return;
    case "azcopy":
      if (p0 === "copy" || p0 === "sync") hit(ctx, "cloud-upload");
      return;
    case "kubectl":
    case "oc":
      if (p0 === "delete" || p0 === "drain" || (p0 === "replace" && t.includes("--force"))) hit(ctx, "infra-destroy");
      return;
    case "helm":
      if (p0 === "uninstall" || p0 === "delete" || p0 === "rollback") hit(ctx, "infra-destroy");
      if (p0 === "push") hit(ctx, "publish");
      return;
    case "terraform":
    case "tofu":
    case "terragrunt":
      if (p0 && /^(?:apply|destroy|import|taint|force-unlock)$/.test(p0)) hit(ctx, "infra-destroy");
      if (p0 === "state" && /^(?:rm|mv|push|replace-provider)$/.test(p[1]?.text ?? "")) hit(ctx, "infra-destroy");
      return;
    case "pulumi":
      if (p0 === "up" || p0 === "destroy" || p0 === "update") hit(ctx, "infra-destroy");
      return;
    case "doctl":
    case "flyctl":
    case "fly":
    case "heroku":
    case "vercel":
    case "netlify":
      if (t.some((a) => /^(?:delete|destroy|remove|rm|apps:destroy|sites:delete)$/.test(a))) hit(ctx, "infra-destroy");
      return;
    case "docker":
    case "podman":
      return container(ctx, args);
    case "dropdb":
    case "dropuser":
      return hit(ctx, "destructive-sql");
    case "chmod":
    case "chown":
    case "chgrp":
    case "setfacl":
      if (t.some((a) => a === "--recursive" || shortHas(a, "R"))) hit(ctx, "recursive-permission");
      return;
    case "rm":
    case "unlink":
    case "rmdir":
      if (via.xargs || via.find || p.some((w) => w.glob || w.dynamic)) hit(ctx, "bulk-delete");
      if (name === "rm" && t.some((a) => shortHas(a, "r") || shortHas(a, "R") || a === "--recursive") && t.some((a) => shortHas(a, "f") || a === "--force")) {
        hit(ctx, "recursive-forced-rm");
      }
      return;
    case "shred":
    case "wipe":
    case "srm":
    case "truncate":
      return hit(ctx, "truncate");
    case ":":
    case "true":
      if (cmd.redirects.some((r) => r.op === ">" || r.op === ">|")) hit(ctx, "truncate");
      return;
    case "cp":
    case "cat":
      if (t.includes("/dev/null") && (name === "cp" || cmd.redirects.some((r) => r.op === ">"))) hit(ctx, "truncate");
      return;
    case "dd":
      if (t.some((a) => a.startsWith("of="))) hit(ctx, "truncate");
      return;
    case "kill":
    case "pkill":
    case "killall":
    case "taskkill":
      return hit(ctx, "process-kill");
    case "fuser":
      if (t.some((a) => shortHas(a, "k"))) hit(ctx, "process-kill");
      return;
    case "systemctl":
    case "service":
    case "launchctl":
      if (t.some((a) => /^(?:stop|kill|restart|reload|disable|mask|unload)$/.test(a))) hit(ctx, "process-kill");
      if (t.some((a) => /^(?:enable|load|bootstrap)$/.test(a))) hit(ctx, "scheduled-job");
      return;
    case "crontab":
      if (!(t.length > 0 && t.every((a) => a === "-l" || a === "-u" || !isOpt(a)) && t.includes("-l"))) hit(ctx, "scheduled-job");
      return;
    case "at":
    case "batch":
      return hit(ctx, "scheduled-job");
    case "npx":
    case "pnpx":
    case "bunx":
    case "uvx":
      return hit(ctx, "dependency");
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun":
    case "deno":
      return jsPackageManager(ctx, name, args);
    case "pip":
    case "pip3":
    case "uv":
    case "pipx":
    case "poetry":
    case "pdm":
    case "conda":
    case "mamba":
      return pythonPackageManager(ctx, name, args);
    case "cargo":
      if (p0 === "add" || p0 === "install") hit(ctx, "dependency");
      if (p0 === "publish") hit(ctx, "publish");
      return;
    case "go":
      if (p0 === "install" || p0 === "get") hit(ctx, "dependency");
      return;
    case "gem":
      if (p0 === "install") hit(ctx, "dependency");
      if (p0 === "push") hit(ctx, "publish");
      return;
    case "bundle":
    case "composer":
      if (p0 === "add" || p0 === "require") hit(ctx, "dependency");
      return;
    case "brew":
    case "apt":
    case "apt-get":
    case "yum":
    case "dnf":
    case "apk":
    case "zypper":
    case "snap":
    case "port":
      if (p0 && /^(?:install|reinstall|add|tap)$/.test(p0)) hit(ctx, "dependency");
      if (p0 && /^(?:remove|purge|uninstall|autoremove|del|erase)$/.test(p0)) hit(ctx, "dependency");
      return;
    case "pacman":
      if (t.some((a) => /^-S/.test(a))) hit(ctx, "dependency");
      return;
    case "dotnet":
      if (p0 === "add" && p[1]?.text === "package") hit(ctx, "dependency");
      if (p0 === "nuget" && p[1]?.text === "push") hit(ctx, "publish");
      return;
    case "twine":
      if (p0 === "upload") hit(ctx, "publish");
      return;
    case "vsce":
    case "ovsx":
    case "lerna":
    case "flit":
    case "hatch":
      if (p0 === "publish") hit(ctx, "publish");
      return;
    case "semantic-release":
      return hit(ctx, "publish");
    case "mvn":
      if (t.includes("deploy")) hit(ctx, "publish");
      return;
    case "gradle":
    case "gradlew":
      if (t.some((a) => /^publish/.test(a))) hit(ctx, "publish");
      return;
    case "awk":
    case "gawk":
      if (t.some((a) => a.includes("system(") || /\|\s*"/.test(a) || /"\s*\|/.test(a))) opaque(ctx, "awk code that runs commands");
      return;
    default:
      if (SQL_CLIENTS.has(name)) return sqlClient(ctx, cmd, name, args);
      return;
  }
}

function reparse(ctx: Ctx, text: string): void {
  if (ctx.depth >= MAX_DEPTH) return opaque(ctx, `nested deeper than ${MAX_DEPTH} levels`);
  readShell({ ...ctx, depth: ctx.depth + 1 }, text);
}

function shellLike(ctx: Ctx, cmd: Cmd, name: string, args: Word[]): void {
  if (name === "eval") {
    if (args.some((a) => a.dynamic)) return opaque(ctx, "eval of a dynamic string");
    return reparse(ctx, args.map((a) => a.text).join(" "));
  }
  if (name === "source" || name === ".") {
    const file = args[0];
    if (!file || file.procsub || file.text === "/dev/stdin" || file.text === "-") return hit(ctx, "pipe-to-shell");
    return;
  }
  // sh/bash/…: `-c STRING` is shell text to read; a script operand is a file; neither means stdin.
  for (let k = 0; k < args.length; k += 1) {
    const a = args[k]!;
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(a.text) && !a.quoted) {
      const script = args[k + 1];
      if (!script) return opaque(ctx, `${name} -c with no command`);
      if (script.dynamic) return opaque(ctx, `${name} -c with a dynamic string`);
      return reparse(ctx, script.text);
    }
    if (a.text === "-s" || a.text === "-") break;
    if (!isOpt(a.text) && !(a.text.startsWith("+") && a.text.length > 1)) {
      if (a.procsub) hit(ctx, "pipe-to-shell");
      return; // runs a script file
    }
  }
  return stdinExec(ctx, cmd, name);
}

/** A shell or interpreter with no code operand reads its program from stdin. */
function stdinExec(ctx: Ctx, cmd: Cmd, name: string): void {
  if (cmd.pipedIn) return hit(ctx, "pipe-to-shell");
  if (cmd.stdin) {
    if (SHELLS.has(name) && cmd.stdin.literal) return reparse(ctx, cmd.stdin.text);
    return hit(ctx, "pipe-to-shell");
  }
  if (cmd.redirects.some((r) => r.op === "<")) return; // runs a file
  return opaque(ctx, `${name} started with no program, reading stdin`);
}

function interpreter(ctx: Ctx, cmd: Cmd, name: string, args: Word[]): void {
  for (let k = 0; k < args.length; k += 1) {
    const a = args[k]!.text;
    if (inlineCodeFlag(name, a)) return opaque(ctx, `inline ${name} code`);
    if (a === "-m" && /^python/i.test(name)) {
      const mod = args[k + 1];
      if (mod?.text === "pip") return pythonPackageManager(ctx, "pip", args.slice(k + 2));
      return;
    }
    if (name === "deno" || name === "bun") return jsPackageManager(ctx, name, args);
    if (a === "-") break;
    if (!isOpt(a)) {
      if (args[k]!.procsub) hit(ctx, "pipe-to-shell");
      return; // runs a script file
    }
  }
  return stdinExec(ctx, cmd, name);
}

function find(ctx: Ctx, cmd: Cmd, args: Word[], hops: number): void {
  if (args.some((a) => a.text === "-delete")) hit(ctx, "bulk-delete");
  for (let k = 0; k < args.length; k += 1) {
    if (!/^-(?:exec|execdir|ok|okdir)$/.test(args[k]!.text)) continue;
    let end = k + 1;
    while (end < args.length && args[end]!.text !== ";" && args[end]!.text !== "+") end += 1;
    analyse(ctx, { ...cmd, pipedIn: false, stdin: undefined, redirects: [] }, args.slice(k + 1, end), { find: true, hops: hops + 1 });
    k = end;
  }
}

function curl(ctx: Ctx, args: Word[]): void {
  for (let k = 0; k < args.length; k += 1) {
    const a = args[k]!.text;
    let method: string | undefined;
    if (a === "-X" || a === "--request") method = args[k + 1]?.text;
    else if (a.startsWith("--request=")) method = a.slice("--request=".length);
    else if (/^-[A-Za-z]*X/.test(a) && !a.startsWith("--")) method = a.slice(a.indexOf("X") + 1) || args[k + 1]?.text;
    if (method && method.toUpperCase() !== "GET" && method.toUpperCase() !== "HEAD") return hit(ctx, "network-write");
    if (/^--(?:data|data-binary|data-raw|data-urlencode|data-ascii|json|form|form-string|upload-file)(?:=|$)/.test(a)) return hit(ctx, "network-write");
    if (/^-[A-Za-z]+$/.test(a) && /[dFT]/.test(a.slice(1, (a.indexOf("X") + 1 || a.length + 1) - 1))) return hit(ctx, "network-write");
  }
}

function gh(ctx: Ctx, args: Word[]): void {
  const t = args.map((a) => a.text);
  const p = positionals(args, new Set(["-R", "--repo", "-X", "--method", "-f", "-F", "--field", "--raw-field", "-H", "--header", "--input"]));
  const [a0, a1] = [p[0]?.text, p[1]?.text];
  if (a0 === "pr" && a1 === "merge" && t.includes("--admin")) hit(ctx, "admin-merge");
  if ((a0 === "release" || a0 === "repo") && a1 === "delete") hit(ctx, "remote-delete");
  if (a0 === "release" && (a1 === "create" || a1 === "upload")) hit(ctx, "publish");
  if (a0 === "api") {
    const m = t.findIndex((x) => x === "-X" || x === "--method");
    const method = m >= 0 ? t[m + 1] : t.find((x) => x.startsWith("--method="))?.slice("--method=".length);
    if (method && WRITE_METHODS.has(method.toUpperCase())) hit(ctx, "network-write");
    if (t.some((x) => /^(?:-f|-F|--field|--raw-field|--input)(?:=|$)/.test(x))) hit(ctx, "network-write");
  }
}

function aws(ctx: Ctx, args: Word[]): void {
  const p = positionals(args, new Set(["--profile", "--region", "--endpoint-url", "--output", "--query", "--exclude", "--include", "--acl", "--storage-class"]));
  const [svc, verb] = [p[0]?.text, p[1]?.text];
  if (svc === "s3" && verb && /^(?:cp|mv|sync)$/.test(verb)) {
    const ops = p.slice(2).map((w) => w.text);
    if (ops.length >= 2 && ops[ops.length - 1]!.startsWith("s3://") && ops.slice(0, -1).some((o) => !o.startsWith("s3://"))) hit(ctx, "cloud-upload");
  }
  if (svc === "s3" && (verb === "rm" || verb === "rb")) hit(ctx, "infra-destroy");
  if (svc === "s3api" && verb === "put-object") hit(ctx, "cloud-upload");
  if (verb && /^(?:delete|terminate|remove|deregister|purge)-/.test(verb)) hit(ctx, "infra-destroy");
}

function gcloudLike(ctx: Ctx, name: string, args: Word[]): void {
  const p = positionals(args, new Set(["--project", "--region", "--zone", "--format"])).map((w) => w.text);
  const upload = (ops: string[]) => ops.length >= 2 && ops[ops.length - 1]!.startsWith("gs://") && ops.slice(0, -1).some((o) => !o.startsWith("gs://"));
  if (name === "gsutil" && /^(?:cp|mv|rsync)$/.test(p[0] ?? "") && upload(p.slice(1))) hit(ctx, "cloud-upload");
  if (name === "gsutil" && /^(?:rm|rb)$/.test(p[0] ?? "")) hit(ctx, "infra-destroy");
  if (name === "gcloud" && p[0] === "storage" && /^(?:cp|mv|rsync)$/.test(p[1] ?? "") && upload(p.slice(2))) hit(ctx, "cloud-upload");
  if (name === "gcloud" && p.includes("delete")) hit(ctx, "infra-destroy");
}

function container(ctx: Ctx, args: Word[]): void {
  const t = args.map((a) => a.text);
  const p = positionals(args, new Set(["-v", "--volume", "--mount", "-w", "--workdir", "-e", "--env", "--name", "-p", "--publish", "--network", "--user", "-u", "--entrypoint"]));
  const verb = p[0]?.text;
  if (verb === "run" || verb === "create") {
    for (let k = 0; k < args.length; k += 1) {
      const a = t[k]!;
      let vol: string | undefined;
      if (a === "-v" || a === "--volume") vol = t[k + 1];
      else if (a.startsWith("--volume=")) vol = a.slice("--volume=".length);
      else if (/^-v./.test(a)) vol = a.slice(2);
      if (vol !== undefined && vol.includes(":") && !/^[A-Za-z0-9][\w.-]*:/.test(vol)) hit(ctx, "container-host-mount");
      const mount = a === "--mount" ? t[k + 1] : a.startsWith("--mount=") ? a.slice("--mount=".length) : undefined;
      if (mount !== undefined && /(?:^|,)type=bind\b/.test(mount)) hit(ctx, "container-host-mount");
      if (a === "--privileged" || /^--(?:pid|ipc|userns|uts)=host$/.test(a) || a === "--network=host" || a === "--net=host") hit(ctx, "container-host-mount");
    }
  }
  if (verb === "push") hit(ctx, "publish");
  if (verb === "kill" || verb === "stop") hit(ctx, "process-kill");
  if ((verb === "system" && p[1]?.text === "prune") || (verb === "volume" && /^(?:rm|prune)$/.test(p[1]?.text ?? ""))) hit(ctx, "infra-destroy");
}

function sqlClient(ctx: Ctx, cmd: Cmd, name: string, args: Word[]): void {
  const text = [...args.map((a) => a.text), cmd.stdin?.text ?? ""].join(" ");
  if (DESTRUCTIVE_SQL.test(text)) hit(ctx, "destructive-sql");
  // SQL the floors cannot see: a file, a redirect or a pipe into the client.
  const fromFile = args.some((a) => a.text === "-f" || a.text === "--file" || a.text.startsWith("--file=") || a.text.startsWith(".read"));
  if (fromFile || cmd.pipedIn || cmd.redirects.some((r) => r.op === "<") || (cmd.stdin && !cmd.stdin.literal)) {
    opaque(ctx, `${name} input from a file or pipe`);
  }
}

function jsPackageManager(ctx: Ctx, name: string, args: Word[]): void {
  const t = args.map((a) => a.text);
  const p = positionals(args, new Set(["--filter", "-F", "-C", "--dir", "--prefix", "-w", "--workspace", "--registry"]));
  const verb = p[0]?.text;
  const operands = p.slice(1);
  const global = t.includes("-g") || t.includes("--global") || t.includes("--location=global") || (name === "yarn" && verb === "global");
  if (verb === "publish" || verb === "unpublish" || (name === "yarn" && verb === "npm" && p[1]?.text === "publish") || (verb === "dist-tag" && p[1]?.text === "add")) {
    return hit(ctx, "publish");
  }
  if (verb === "dlx" || (verb === "exec" && name === "npm") || verb === "x" || verb === "create" || (verb === "init" && operands.length > 0)) {
    return hit(ctx, "dependency");
  }
  // `deno run https://…` downloads and runs remote code.
  if (name === "deno" && (verb === "run" || verb === "install") && operands.some((w) => w.text.includes("://"))) return hit(ctx, "dependency");
  if (verb === "add" || (verb === "global" && p[1]?.text === "add")) return hit(ctx, "dependency");
  if ((verb === "install" || verb === "i" || verb === "isntall") && (operands.length > 0 || global)) return hit(ctx, "dependency");
}

function pythonPackageManager(ctx: Ctx, name: string, args: Word[]): void {
  const p = positionals(args, new Set(["-r", "--requirement", "-c", "--constraint", "-e", "--editable", "-i", "--index-url", "--extra-index-url", "-t", "--target", "--python", "-p"]));
  let verb = p[0]?.text;
  let operands = p.slice(1);
  if (name === "uv" && verb === "pip") {
    verb = p[1]?.text;
    operands = p.slice(2);
  }
  if (name === "uv" && verb === "tool" && (p[1]?.text === "install" || p[1]?.text === "run")) return hit(ctx, "dependency");
  if (name === "pipx" && (verb === "install" || verb === "run" || verb === "inject")) return hit(ctx, "dependency");
  if (verb === "add") return hit(ctx, "dependency");
  if (name === "poetry" || name === "pdm" || name === "uv") {
    if (verb === "publish") hit(ctx, "publish");
    if (name !== "uv" || p[0]?.text !== "pip") return;
  }
  // `pip install pkg` names a package; `pip install .`, `-e .` and `-r file` install what the repo declares.
  const packages = operands.filter((w) => !/^(?:\.{1,2}(?:\/.*)?|\/.*|[\w.-]*\/.*)$/.test(w.text));
  if (verb === "install" && packages.length > 0) hit(ctx, "dependency");
}

function git(ctx: Ctx, args: Word[]): void {
  // Global options come before the subcommand.
  let k = 0;
  while (k < args.length && isOpt(args[k]!.text)) k += ["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(args[k]!.text) ? 2 : 1;
  const sub = args[k]?.text;
  const rest = args.slice(k + 1);
  const t = rest.map((a) => a.text);
  const p = positionals(rest, new Set(["-m", "-F", "-b", "-B", "-c", "-C", "--repo", "-o", "--push-option", "--exec", "-u", "--set-upstream-to"]));
  const p0 = p[0]?.text;
  switch (sub) {
    case "remote":
      if (p0 === "add" || p0 === "set-url") hit(ctx, "new-remote");
      if (p0 === "remove" || p0 === "rm") hit(ctx, "local-ref-destruction");
      return;
    case "config":
      if (p.some((w) => /^remote\..+\.(?:url|pushurl)$/i.test(w.text) || /^url\..+\.(?:insteadof|pushinsteadof)$/i.test(w.text))) hit(ctx, "new-remote");
      return;
    case "push": {
      const remote = p0;
      if (t.some((a) => a.startsWith("--repo="))) hit(ctx, "new-remote");
      if (remote && (remote.includes("://") || /^[\w.-]+@[\w.-]+:/.test(remote) || /^(?:\/|\.{1,2}\/|~)/.test(remote) || /^[\w.-]+\.[a-z]{2,}:/.test(remote))) {
        hit(ctx, "new-remote");
      }
      if (t.includes("--delete") || t.includes("-d") || t.includes("--prune") || p.slice(1).some((w) => w.text.startsWith(":"))) hit(ctx, "remote-delete");
      if (t.includes("--mirror") || t.some((a) => /^--force(?:-with-lease|-if-includes)?(?:=|$)/.test(a) || shortHas(a, "f")) || p.slice(1).some((w) => w.text.startsWith("+"))) {
        hit(ctx, "history-rewrite");
      }
      return;
    }
    case "branch":
      if (t.some((a) => a === "-D" || /^-[a-zA-Z]*D/.test(a) || a === "-M" || a === "-C") || ((t.includes("-d") || t.includes("--delete")) && (t.includes("-f") || t.includes("--force")))) {
        hit(ctx, "local-ref-destruction");
      }
      return;
    case "tag":
      if (t.includes("-d") || t.includes("--delete")) hit(ctx, "local-ref-destruction");
      return;
    case "stash":
      if (p0 === "drop" || p0 === "clear") hit(ctx, "local-ref-destruction");
      return;
    case "checkout":
    case "restore":
    case "switch": {
      if (sub === "restore" && t.includes("--staged") && !t.includes("--worktree") && !t.includes("-W")) return;
      const force = t.includes("-f") || t.includes("--force") || t.includes("--discard-changes");
      const wholeTree = rest.some((w) => w.text === "." || w.text === ":/" || w.text === "*");
      if (force || (sub !== "switch" && wholeTree)) hit(ctx, "local-ref-destruction");
      return;
    }
    case "reset":
      if (t.includes("--hard") || t.includes("--merge") || t.includes("--keep")) hit(ctx, "history-rewrite");
      return;
    case "clean":
      if (t.some((a) => a === "--force" || shortHas(a, "f"))) hit(ctx, "history-rewrite");
      return;
    case "filter-branch":
    case "filter-repo":
    case "prune":
      return hit(ctx, "history-rewrite");
    case "reflog":
      if (p0 === "expire" || p0 === "delete") hit(ctx, "history-rewrite");
      return;
    case "gc":
      if (t.some((a) => /^--prune(?:=(?:now|all))?$/.test(a) && a !== "--prune=never")) hit(ctx, "history-rewrite");
      return;
    case "update-ref":
      if (t.includes("-d")) hit(ctx, "history-rewrite");
      return;
    case "worktree":
      if (p0 === "remove" && (t.includes("--force") || t.includes("-f"))) hit(ctx, "local-ref-destruction");
      return;
    default:
      return;
  }
}

/** Read `text` as shell and run every per-command rule over it. */
function readShell(ctx: Ctx, text: string): void {
  if (text.length > MAX_FLOOR_COMMAND_CHARS) return opaque(ctx, `a command over ${MAX_FLOOR_COMMAND_CHARS} characters`);
  const r = new ShellReader(text).read(ctx.depth);
  if (r.failed) return opaque(ctx, r.failed);
  for (const why of r.opaque) opaque(ctx, why);
  for (const cmd of r.cmds) {
    for (const redir of cmd.redirects) {
      // A write to a path held in a variable: the target is not known here.
      const home = /^\$\{?HOME\b/.test(redir.target.text);
      if (redir.target.dynamic && !home && redir.op !== "<") opaque(ctx, "a redirect to a path held in a variable");
      checkPathWord(ctx, redir.target);
    }
    analyse(ctx, cmd, cmd.words);
  }
}

/* ------------------------------------------------------------------------- *
 * Public surface
 * ------------------------------------------------------------------------- */

/** What the gate observes about one tool call, from a normalized `tool.started` / `approval.requested` payload. */
export interface ToolAction {
  toolName: string;
  commandText?: string;
  paths: string[];
  /** True when `commandText` came from a `command` field, i.e. it is shell, not `JSON.stringify(input)`. */
  shell: boolean;
}

/**
 * The one extraction of a tool call from its event, shared by the runner's
 * gate and the offline floor discovery job so both see the same action.
 * Name extraction matches `toolPolicyGuard`, so a rules deny agrees.
 */
export function toolActionFromEvent(payload: unknown, summary: string | undefined): ToolAction {
  const p = (payload ?? {}) as { tool?: string; command?: string; input?: unknown };
  const input = (p.input && typeof p.input === "object" ? p.input : {}) as Record<string, unknown>;
  const toolName = p.tool ?? p.command ?? summary ?? "";
  const shellText = typeof p.command === "string" ? p.command : typeof input.command === "string" ? input.command : undefined;
  const commandText = shellText ?? (p.input !== undefined ? JSON.stringify(p.input) : undefined);
  const paths = ["file_path", "notebook_path", "path"].flatMap((k) => (typeof input[k] === "string" ? [input[k] as string] : []));
  return { toolName, commandText, paths, shell: shellText !== undefined };
}

/** K19g's keyed floors, re-stated as rules. They still feed the judge comparisons unchanged. */
const K19G_RULES: Record<string, Exclude<FloorRule, "opaque">> = {
  "path outside worktree": "path-outside-worktree",
  "write outside worktree (not in git)": "write-outside-worktree",
  "recursive forced rm": "recursive-forced-rm",
  "git history rewrite": "history-rewrite",
  "credential file named": "credential-file",
  "file upload": "file-upload",
};

/**
 * Every floor that fires on one proposed action, deduplicated by rule and in
 * a fixed order. Empty means no floor fired: the gate adds nothing and
 * `approvalMode` decides, as it would without M16. Pure.
 *
 * `shell` says whether `commandText` is shell (the runner knows: it came from
 * a `command` field). When the caller does not say, a tool named like a shell
 * is taken as one.
 */
export function toolGateFloorHits(input: ToolGateObservation & { shell?: boolean }): FloorHit[] {
  const ctx: Ctx = { worktree: input.worktreePath, depth: 0, hits: [] };
  for (const label of Object.values(toolGateFloors(input))) {
    const rule = K19G_RULES[label];
    if (rule) hit(ctx, rule);
  }
  const shell = input.shell ?? SHELL_TOOLS.test(input.toolName);
  if (shell) {
    if (input.commandText === undefined || input.commandText.trim() === "") opaque(ctx, "a shell tool with no command");
    else readShell(ctx, input.commandText);
  } else if (!KNOWN_FILE_TOOLS.test(input.toolName) && !KNOWN_NO_EFFECT_TOOLS.test(input.toolName)) {
    opaque(ctx, "a tool whose input no floor understands");
  }
  const seen = new Set<string>();
  return ctx.hits
    .filter((h) => {
      const key = `${h.rule}|${h.reason}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));
}

/**
 * The tool gate's mapping since K19i: rules and floors decide, no judge is
 * read. Subordinate to I-D1 exactly as before — read-only is the ceiling, a
 * rules deny blocks, and a floor can only add a prompt. `auto-approve` still
 * means "the gate adds nothing; approvalMode decides". Pure.
 */
export function resolveFloorGate(input: {
  rulesDenied: boolean;
  approvalMode: PermissionPolicy["mode"];
  hits: readonly FloorHit[];
}): ToolGateVerdict {
  if (input.approvalMode === "read-only") return { outcome: "unchanged", reason: "read-only workspace: approvalMode is the ceiling" };
  if (input.rulesDenied) return { outcome: "block", reason: "rules deny (final, I-D1)" };
  if (input.hits.length > 0) {
    return { outcome: "prompt", reason: `floors: ${input.hits.map((h) => `[${h.rule}] ${h.reason}`).join(" ")}` };
  }
  return { outcome: "auto-approve", reason: "no floor fired; approvalMode decides" };
}
