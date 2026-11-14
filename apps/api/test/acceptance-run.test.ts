/**
 * P0-4 (docs/agentic-os-auto-copilot-plan.md §C.2.7): acceptance runs on a real git repository
 * and a real SQLite database, with a local executor standing in for the agent wrapper.
 *
 * G10 (empty plan, missing acceptance, FAIL, PASS with the checkpoint SHA, crash mid-command
 * replay-safe → new run_no on a new snapshot, a writer touching the task worktree during the run),
 * G25 (stop now during acceptance; acceptance that would cross the close: not started, or cut at
 * the deadline) and G28 (crash in a command that is not replay-safe → blocked with the unknown
 * effect listed; a command that modifies the snapshot and restores it → blocked).
 */
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db/index.js";
import {
  AcceptanceRunner, agentAcceptanceExecutor, parseBacklogAcceptance, type AcceptanceExecutor, type AcceptanceDeps,
} from "../src/modules/acceptance-run.js";

const g = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const iso = (ms: number) => new Date(ms).toISOString();

/** Runs as the test's own user, with the network it has: TEST-ONLY, hence `allowOnlineExecutor`. */
function localExecutor(opts: { hang?: boolean } = {}): AcceptanceExecutor & { seen: string[] } {
  const seen: string[] = [];
  return {
    offline: false,
    seen,
    stop: async () => {},
    exec: (req, signal) => {
      seen.push(req.cwd);
      // A hung command: only an abort (the poll, once the "dead" plane's database is closed) ends it.
      if (opts.hang) return new Promise((resolve) => signal.addEventListener("abort", () => resolve({ exitCode: null, signal: "SIGKILL", output: "" }), { once: true }));
      return new Promise((resolve) => {
        const child = spawn("/bin/sh", ["-c", req.command], { cwd: req.cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
        let out = "";
        child.stdout.on("data", (b: Buffer) => { out += b.toString(); });
        child.stderr.on("data", (b: Buffer) => { out += b.toString(); });
        // The whole process group, like stopping the scope.
        signal.addEventListener("abort", () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } }, { once: true });
        child.on("close", (code, sig) => resolve({ exitCode: code, signal: sig, output: out }));
      });
    },
  };
}

interface World { root: string; repo: string; worktree: string; db: Db; reservationSha: string; attemptId: string; taskId: string }
let world: World | undefined;
const dbs: Db[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
  if (world) {
    try { execFileSync("chmod", ["-R", "u+w", world.root]); } catch { /* ignore */ }
    rmSync(world.root, { recursive: true, force: true });
  }
  world = undefined;
});

let n = 0;
/**
 * A repo whose `origin/main` carries the backlog, a reservation commit on top of it, a task
 * worktree with the agent's change, and an attempt `settled` inside an open window.
 */
function setup(acceptanceYaml: string | null, opts: { windowMs?: number; budgetMs?: number; worktreeChange?: (wt: string) => void; reservationSha?: string } = {}): World {
  const root = mkdtempSync(join(tmpdir(), "acc-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "docs/progress"), { recursive: true });
  g(root, "init", "-q", "-b", "main", repo);
  g(repo, "config", "user.name", "Test"); g(repo, "config", "user.email", "test@example.invalid"); g(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "hello\n");
  writeFileSync(join(repo, "check.sh"), "#!/bin/sh\ngrep -q feature src.txt\n");
  chmodSync(join(repo, "check.sh"), 0o755);
  writeFileSync(join(repo, "src.txt"), "base\n");
  const items = acceptanceYaml === null ? "  - id: item-1\n    lane: oci-loop\n" : `  - id: item-1\n    lane: oci-loop\n    acceptance:\n${acceptanceYaml}`;
  writeFileSync(join(repo, "docs/progress/backlog.yaml"), `version: 1\nitems:\n${items}`);
  g(repo, "add", "-A"); g(repo, "commit", "-q", "-m", "base");
  g(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  g(repo, "commit", "-q", "--allow-empty", "-m", "aos-reservation item=item-1 lane=oci-loop reservation=r1");
  const reservationSha = opts.reservationSha ?? g(repo, "rev-parse", "HEAD");
  const worktree = join(root, "worktrees", "task-1");
  mkdirSync(join(root, "worktrees"), { recursive: true });
  g(repo, "worktree", "add", "-q", "-b", "os/item-1", worktree, g(repo, "rev-parse", "HEAD"));
  (opts.worktreeChange ?? ((wt) => writeFileSync(join(wt, "src.txt"), "base\nfeature\n")))(worktree);

  const db = openDb(join(root, "plane.db"));
  dbs.push(db);
  const now = Date.now();
  const taskId = `task_${++n}`;
  db.prepare("INSERT INTO tasks(id, goal, state, repo_path, envelope, created_at, updated_at, worktree_path) VALUES(?,?,?,?,?,?,?,?)")
    .run(taskId, "ship", "COMPLETED", repo, "{}", iso(now), iso(now), worktree);
  const attemptId = `apa_${n}`;
  db.prepare(`INSERT INTO autopilot_attempts(id, item_id, attempt_no, reservation_id, reservation_sha, task_id, state, runtime_budget_ms, created_at, updated_at)
    VALUES(?,?,?,?,?,?,'settled',?,?,?)`).run(attemptId, "item-1", 1, `r${n}`, reservationSha, taskId, opts.budgetMs ?? 90 * 60_000, iso(now), iso(now));
  db.prepare("INSERT INTO autopilot_windows(id, opens_at, closes_at, max_items, created_by, created_at) VALUES(?,?,?,?,?,?)")
    .run("apw_1", iso(now - 60_000), iso(now + (opts.windowMs ?? 8 * 3_600_000)), 3, "op_test", iso(now));
  db.prepare("UPDATE autopilot_state SET status = 'running', stop_reason = NULL WHERE id = 1").run();
  world = { root, repo, worktree, db, reservationSha, attemptId, taskId };
  return world;
}

function runner(w: World, executor: AcceptanceExecutor = localExecutor(), extra: Partial<AcceptanceDeps> = {}): AcceptanceRunner {
  return new AcceptanceRunner({
    db: w.db, bounds: { minSliceMs: 1_000, graceMs: 500 }, executor, backlog: { repoPath: w.repo },
    snapshotsRoot: join(w.root, "worktrees", "acceptance"), pollMs: 50, allowOnlineExecutor: true, ...extra,
  });
}
const attemptState = (w: World) => (w.db.prepare("SELECT state, reason FROM autopilot_attempts WHERE id = ?").get(w.attemptId) as { state: string; reason: string | null });
const cmds = (...c: Array<[string, boolean]>) => `      commands:\n${c.map(([run, safe]) => `        - run: ${JSON.stringify(run)}\n          replaySafe: ${safe}\n`).join("")}      writable: [dist, {file: status.json}, {file: docs/progress/state.json}]\n`;

describe("acceptance spec (trusted source)", () => {
  it("validates the backlog entry and refuses unsafe writable paths", () => {
    const y = (acc: string) => `items:\n  - id: a\n    acceptance:\n${acc}`;
    expect(parseBacklogAcceptance(y("      commands: []\n"), "a")).toEqual({ problem: "item a has an empty acceptance command list" });
    expect(parseBacklogAcceptance("items:\n  - id: a\n", "a")).toEqual({ problem: "item a has no acceptance" });
    expect(parseBacklogAcceptance(y("      commands:\n        - run: x\n"), "b")).toEqual({ problem: "item b is not in the backlog" });
    expect(parseBacklogAcceptance(y("      commands:\n        - run: x\n          replaySafe: yes-please\n"), "a")).toHaveProperty("problem");
    for (const bad of ["../x", "/etc", ".git/hooks", "a/../../b"]) {
      expect(parseBacklogAcceptance(y(`      commands:\n        - run: x\n      writable: [${JSON.stringify(bad)}]\n`), "a")).toHaveProperty("problem");
    }
    // replaySafe defaults to false.
    expect(parseBacklogAcceptance(y("      commands:\n        - run: x\n      writable: [dist/]\n"), "a"))
      .toEqual({ spec: { commands: [{ run: "x", replaySafe: false }], writable: ["dist"], writableFiles: [] } });
    expect(parseBacklogAcceptance(y("      commands:\n        - run: x\n      writable: [node_modules, {file: status.json}]\n"), "a"))
      .toEqual({ spec: { commands: [{ run: "x", replaySafe: false }], writable: ["node_modules"], writableFiles: ["status.json"] } });
    expect(parseBacklogAcceptance(y("      commands:\n        - run: x\n      writable: [{file: ../x}]\n"), "a")).toHaveProperty("problem");
  });

  it("refuses an executor that does not declare itself offline", () => {
    const w = setup(cmds(["true", true]));
    expect(() => new AcceptanceRunner({ db: w.db, bounds: { minSliceMs: 1, graceMs: 0 }, executor: localExecutor(), backlog: { repoPath: w.repo }, snapshotsRoot: w.root }))
      .toThrow(/offline executor/);
  });
});

describe("G10 acceptance outcomes", () => {
  it("empty plan and missing acceptance are blocked, never passed", async () => {
    const w = setup("      commands: []\n");
    const out = await runner(w).accept(w.attemptId);
    expect(out.started && out.run.state).toBe("blocked");
    expect(attemptState(w)).toEqual({ state: "blocked", reason: "acceptance: item item-1 has an empty acceptance command list" });

    const w2 = setup(null);
    const out2 = await runner(w2).accept(w2.attemptId);
    expect(out2.started && out2.run.state).toBe("blocked");
    expect(attemptState(w2).reason).toBe("acceptance: item item-1 has no acceptance");
  });

  it("a failing command fails the attempt", async () => {
    const w = setup(cmds(["./check.sh", true], ["exit 3", true]));
    const out = await runner(w).accept(w.attemptId);
    if (!out.started) throw new Error(out.reason);
    expect(out.run.state).toBe("failed");
    expect(out.run.commands.map((c) => c.status)).toEqual(["passed", "failed"]);
    expect(attemptState(w)).toEqual({ state: "failed", reason: "acceptance failed: command 2 exited 3: exit 3" });
  });

  it("PASS binds the checkpoint SHA; the snapshot is fresh, read-only and removed; the writer's worktree is not consulted", async () => {
    const w = setup(cmds(
      ["./check.sh", true],
      ["stat -c '%a' README.md check.sh . dist && mkdir -p dist && echo built > dist/out.txt", true],
      // The agent keeps writing into its task worktree while acceptance runs: no effect on the snapshot.
      ["sleep 0.4 && grep -q feature src.txt", true],
      // A file that does not exist yet, in a read-only directory: absent until the command writes it.
      ["test ! -e status.json && echo '{}' > status.json && cat status.json && echo '{}' > docs/progress/state.json", true],
    ));
    const exec = localExecutor();
    const r = runner(w, exec);
    const pending = r.accept(w.attemptId);
    await new Promise((res) => setTimeout(res, 150));
    writeFileSync(join(w.worktree, "src.txt"), "rewritten during acceptance\n");
    const out = await pending;
    if (!out.started) throw new Error(out.reason);
    expect(out.run.state).toBe("passed");
    expect(out.attemptState).toBe("accepted");
    const head = g(w.worktree, "rev-parse", "HEAD");
    expect(out.run.sha).toBe(head);
    expect(r.verifiedSha(w.attemptId)).toBe(head);
    expect(g(w.repo, "show", `${head}:src.txt`)).toBe("base\nfeature");
    g(w.repo, "merge-base", "--is-ancestor", w.reservationSha, head); // throws if not
    expect(out.run.commands[1]!.outputTail!.trim().split("\n")).toEqual(["440", "550", "2550", "2770"]);
    expect(out.run.treeBefore).toBe(out.run.treeAfter);
    expect(out.run.sourceSha).toBe(g(w.repo, "rev-parse", "origin/main"));
    expect(exec.seen.every((c) => c === out.run.snapshotPath)).toBe(true);
    expect(existsSync(out.run.snapshotPath!)).toBe(false);
    expect(g(w.repo, "worktree", "list")).not.toContain("acceptance");
    // Acceptance time is charged to the attempt (invariant 4).
    expect(w.db.prepare("SELECT session_id FROM autopilot_runtime WHERE attempt_id = ?").all(w.attemptId)).toEqual([{ session_id: `acceptance:${out.run.id}` }]);
  });

  it("commands come from origin/main, never from the worktree's own backlog", async () => {
    const w = setup(cmds(["exit 1", true]), {
      worktreeChange: (wt) => {
        writeFileSync(join(wt, "src.txt"), "feature\n");
        writeFileSync(join(wt, "docs/progress/backlog.yaml"), "version: 1\nitems:\n  - id: item-1\n    acceptance:\n      commands:\n        - run: \"true\"\n          replaySafe: true\n");
      },
    });
    const out = await runner(w).accept(w.attemptId);
    expect(out.started && out.run.state).toBe("failed");
  });

  it("a failed lineage check is blocked", async () => {
    const w = setup(cmds(["true", true]), { reservationSha: "f".repeat(40) });
    const out = await runner(w).accept(w.attemptId);
    expect(out.started && out.run.state).toBe("blocked");
    expect(attemptState(w).reason).toMatch(/^acceptance: lineage: reservation f{40} is not an ancestor/);
  });

  it("a crash mid-command, all replay-safe: crashed run, then a new run_no on a new snapshot", async () => {
    const w = setup(cmds(["./check.sh", true], ["sleep 1", true]));
    void runner(w, localExecutor({ hang: true })).accept(w.attemptId).catch(() => {});
    await waitFor(() => (w.db.prepare("SELECT state FROM acceptance_runs").get() as { state: string } | undefined)?.state === "running");
    // The plane dies here. A new process boots on the same database.
    const db2 = openDb(join(w.root, "plane.db"));
    dbs.push(db2);
    const booted = runner({ ...w, db: db2 });
    const [crashed] = await booted.reconcileOnBoot();
    expect(crashed!.state).toBe("crashed");
    expect(crashed!.unknownEffects).toBeUndefined();
    expect((db2.prepare("SELECT state FROM autopilot_attempts WHERE id = ?").get(w.attemptId) as { state: string }).state).toBe("accepting");
    expect(existsSync(crashed!.snapshotPath!)).toBe(false);
    // Second run: cheap commands now (the backlog is unchanged; the hanging executor is gone).
    const out = await runner({ ...w, db: db2 }, localExecutor()).accept(w.attemptId);
    if (!out.started) throw new Error(out.reason);
    expect(out.run.runNo).toBe(2);
    expect(out.run.snapshotPath).not.toBe(crashed!.snapshotPath);
    expect(out.run.sha).toBe(crashed!.sha);
  }, 15_000);
});

describe("G28 acceptance replay and tree hash", () => {
  it("a crash in a command that is not replay-safe blocks the attempt and lists the unknown effect", async () => {
    const w = setup(cmds(["./check.sh", true], ["./deploy-something", false]));
    void runner(w, localExecutor({ hang: true })).accept(w.attemptId).catch(() => {});
    await waitFor(() => (w.db.prepare("SELECT state FROM acceptance_runs").get() as { state: string } | undefined)?.state === "running");
    const db2 = openDb(join(w.root, "plane.db"));
    dbs.push(db2);
    const [crashed] = await runner({ ...w, db: db2 }).reconcileOnBoot();
    expect(crashed!.unknownEffects).toEqual(["interrupted: ./check.sh"]);
    const a = db2.prepare("SELECT state, reason FROM autopilot_attempts WHERE id = ?").get(w.attemptId) as { state: string; reason: string };
    expect(a.state).toBe("blocked");
    expect(a.reason).toContain("unknown effects");
    const again = await runner({ ...w, db: db2 }).accept(w.attemptId);
    expect(again.started).toBe(false);
  });

  it("a command that modifies a tracked file and restores it is caught by the tree hash", async () => {
    const w = setup(cmds(["chmod u+w README.md && cp README.md /tmp/acc-keep-$$ && echo x >> README.md && cat /tmp/acc-keep-$$ > README.md && rm /tmp/acc-keep-$$ && chmod 440 README.md", true]));
    const out = await runner(w).accept(w.attemptId);
    if (!out.started) throw new Error(out.reason);
    expect(out.run.commands[0]!.status).toBe("passed");
    expect(out.run.state).toBe("blocked");
    expect(out.run.treeDiff).toEqual(["README.md"]);
    expect(attemptState(w)).toEqual({ state: "blocked", reason: "acceptance: tracked tree changed" });
  });
});

describe("G25 stop and the window during acceptance", () => {
  it("stop now during acceptance: the run is blocked, the attempt cancelled", async () => {
    const w = setup(cmds(["sleep 5", true]));
    const pending = runner(w).accept(w.attemptId);
    await waitFor(() => (w.db.prepare("SELECT state FROM acceptance_runs").get() as { state: string } | undefined)?.state === "running");
    await new Promise((res) => setTimeout(res, 100));
    w.db.prepare("UPDATE autopilot_state SET status = 'stopped', stop_reason = 'operator' WHERE id = 1").run();
    const t = Date.now();
    const out = await pending;
    expect(Date.now() - t).toBeLessThan(2_000);
    expect(out.started && out.run.state).toBe("blocked");
    expect(out.started && out.run.commands[0]!.status).toBe("stopped");
    expect(attemptState(w).state).toBe("cancelled");
  });

  it("a stopped autopilot starts no acceptance", async () => {
    const w = setup(cmds(["true", true]));
    w.db.prepare("UPDATE autopilot_state SET status = 'stopped' WHERE id = 1").run();
    expect(await runner(w).accept(w.attemptId)).toEqual({ started: false, reason: "autopilot is stopped", attemptState: "settled" });
  });

  it("acceptance that would cross the close is not started: the attempt is suspended", async () => {
    const w = setup(cmds(["true", true]), { windowMs: 500 });
    const out = await runner(w).accept(w.attemptId);
    expect(out).toEqual({ started: false, reason: "window_closed", attemptState: "suspended" });
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM acceptance_runs").get()).toEqual({ n: 0 });
  });

  it("cut at the window deadline: replay-safe → suspended, otherwise blocked", async () => {
    const w = setup(cmds(["sleep 10", true]), { windowMs: 2_500 });
    const out = await runner(w).accept(w.attemptId);
    expect(out.started && out.run.state).toBe("cut");
    expect(out.started && out.run.deadlineBound).toBe("window");
    expect(attemptState(w).state).toBe("suspended");

    const w2 = setup(cmds(["sleep 10", false]), { windowMs: 2_500 });
    const out2 = await runner(w2).accept(w2.attemptId);
    expect(out2.started && out2.run.state).toBe("cut");
    expect(attemptState(w2)).toEqual({ state: "blocked", reason: "acceptance cut during a command that is not replay-safe" });
  }, 15_000);

  it("cut at the budget deadline fails the attempt", async () => {
    const w = setup(cmds(["sleep 10", true]), { budgetMs: 1_500 });
    const out = await runner(w).accept(w.attemptId);
    expect(out.started && out.run.deadlineBound).toBe("budget");
    expect(attemptState(w)).toEqual({ state: "failed", reason: "budget_exhausted: acceptance cut at the deadline" });
  }, 15_000);
});

describe("agent executor", () => {
  it("calls the root accept wrapper (its own sudoers line) with a bounded scope and a shell command", async () => {
    const root = mkdtempSync(join(tmpdir(), "acc-sudo-"));
    const fakeSudo = join(root, "sudo");
    writeFileSync(fakeSudo, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done\n`);
    chmodSync(fakeSudo, 0o755);
    const exec = agentAcceptanceExecutor({ sudo: fakeSudo, wrapper: "/usr/local/lib/aos/run-as-agent" });
    expect(exec.offline).toBe(true);
    const res = await exec.exec({ unit: "acc-abc-1", cwd: "/var/lib/aos/worktrees/acceptance/acr_1", command: "pnpm test", timeoutMs: 90_500 }, new AbortController().signal);
    expect(res.output.trim().split("\n")).toEqual([
      "-n", "--", "/usr/local/lib/aos/accept-as-agent",
      "run", "acc-abc-1", "91", "/var/lib/aos/worktrees/acceptance/acr_1", "--", "/bin/sh", "-c", "pnpm test",
    ]);
    await expect(exec.exec({ unit: "bad unit", cwd: "/", command: "x", timeoutMs: 1000 }, new AbortController().signal)).rejects.toThrow(/safe unit/);
    rmSync(root, { recursive: true, force: true });
  });

  it("the accept wrapper makes the namespace as root, then drops to aos-agent before the command", () => {
    const src = readFileSync(join(__dirname, "../../../setup/accept-as-agent"), "utf8");
    expect(src).toContain('[ "$(id -u)" = 0 ] ||');
    const chain = src.slice(src.indexOf("exec systemd-run --scope"));
    const order = ["-p RuntimeMaxSec=\"$secs\"", "/usr/bin/unshare --net --", "/usr/sbin/ip link set lo up || exit 70",
      "/usr/bin/setpriv --reuid=\"$AGENT\" --regid=\"$GROUP\" --init-groups --no-new-privs --inh-caps=-all --bounding-set=-all", "/usr/bin/env -i"];
    const at = order.map((s) => chain.indexOf(s));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(src).not.toContain("--user");
    const sudoers = readFileSync(join(__dirname, "../../../setup/sudoers.d/aos"), "utf8");
    expect(sudoers).toContain("ubuntu ALL=(root) NOPASSWD: /usr/local/lib/aos/accept-as-agent\n");
    // The agent wrapper itself is unchanged: no accept mode there.
    expect(readFileSync(join(__dirname, "../../../setup/run-as-agent"), "utf8")).not.toContain("accept");
  });
});

async function waitFor(cond: () => boolean, ms = 5_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((res) => setTimeout(res, 20));
  }
}
