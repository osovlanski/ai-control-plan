#!/usr/bin/env python3
"""Autopilot state helper. Stdlib only, so it runs in a cloud session and on ai-workstation alike.

Each lane owns exactly one state file (autopilot/state/<lane>.json), so two lanes never edit the
same file and pushes to the integration branch never conflict on content.

Exit codes: 0 ok · 3 lane gated (paused / blocked_until in the future) · 4 nothing to do · 1 error.
"""
import argparse, datetime as dt, json, os, shutil, subprocess, sys, time, urllib.request

CHECKOUT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BRANCH = "autopilot/integration"
# State is read and written in a dedicated worktree pinned to the integration branch, never in the
# checkout the agent codes in — otherwise a sync from a slice branch would push slice commits.
REPO = os.environ.get("AUTOPILOT_STATE_DIR") or os.path.join(
    os.path.dirname(CHECKOUT), ".autopilot-state-" + os.path.basename(CHECKOUT))
ROOT = os.path.join(REPO, "autopilot")
BACKLOG = os.path.join(ROOT, "backlog.json")


def refresh():
    """Create the state worktree if needed and fast-forward it to the remote integration branch."""
    run = lambda *a, **k: subprocess.run(["git", *a], capture_output=True, text=True, **k)
    run("-C", CHECKOUT, "fetch", "-q", "origin", BRANCH)
    if not os.path.isdir(os.path.join(REPO, "autopilot")):
        run("-C", CHECKOUT, "worktree", "prune")
        r = run("-C", CHECKOUT, "worktree", "add", "-f", "--detach", REPO, f"origin/{BRANCH}")
        if r.returncode != 0:
            raise SystemExit(f"cannot create state worktree: {r.stderr}")
    else:
        run("-C", REPO, "fetch", "-q", "origin", BRANCH)
        dirty = run("-C", REPO, "status", "--porcelain").stdout.strip()
        if not dirty:
            run("-C", REPO, "reset", "-q", "--hard", f"origin/{BRANCH}")
MAX_ATTEMPTS = 3
DONE = {"merged", "skipped"}


def now():
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0)


def iso(t):
    return t.isoformat().replace("+00:00", "Z")


def parse(s):
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00")) if s else None


def load(path):
    with open(path) as f:
        return json.load(f)


def save(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def lane_path(lane):
    return os.path.join(ROOT, "state", f"{lane}.json")


def all_states():
    out = {}
    for name in os.listdir(os.path.join(ROOT, "state")):
        if name.endswith(".json"):
            out.update(load(os.path.join(ROOT, "state", name)).get("items", {}))
    return out


def log(state, msg):
    state.setdefault("log", []).append({"at": iso(now()), "msg": msg})
    state["log"] = state["log"][-60:]
    state["updated_at"] = iso(now())


def git(*args, check=True):
    return subprocess.run(["git", "-C", REPO, *args], check=check, capture_output=True, text=True)


def sync(lane, message):
    """Commit this lane's state file and push to the integration branch, rebasing on races."""
    branch = BRANCH
    rel = os.path.relpath(lane_path(lane), REPO)
    git("add", rel)
    if git("diff", "--cached", "--quiet", check=False).returncode == 0:
        return
    git("commit", "-m", f"autopilot({lane}): {message}", "-m",
        "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" if lane == "claude" else "Autopilot codex lane")
    for attempt in range(5):
        git("fetch", "origin", branch, check=False)
        r = git("rebase", f"origin/{branch}", check=False)
        if r.returncode != 0:
            git("rebase", "--abort", check=False)
            raise SystemExit(f"rebase failed: {r.stderr}")
        if git("push", "origin", f"HEAD:{branch}", check=False).returncode == 0:
            return
        time.sleep(3 * (attempt + 1))
    raise SystemExit("push failed after retries")


def github(method, path, body=None):
    """GitHub REST. Prefers gh; else curl-equivalent via urllib with GITHUB_TOKEN if set
    (cloud sessions are authenticated by their egress proxy, so no token is needed there)."""
    if shutil.which("gh"):
        cmd = ["gh", "api", "-X", method, path]
        if body is not None:
            cmd += ["--input", "-"]
        r = subprocess.run(cmd, input=json.dumps(body) if body is not None else None,
                           capture_output=True, text=True)
        if r.returncode != 0:
            raise SystemExit(f"gh api {path} failed: {r.stderr}")
        return json.loads(r.stdout or "null")
    req = urllib.request.Request("https://api.github.com" + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("Content-Type", "application/json")
    if os.environ.get("GITHUB_TOKEN"):
        req.add_header("Authorization", "Bearer " + os.environ["GITHUB_TOKEN"])
    with urllib.request.urlopen(req, timeout=60) as resp:
        raw = resp.read()
        return json.loads(raw) if raw else None


def cmd_gate(a):
    s = load(lane_path(a.lane))
    if s.get("paused"):
        print("paused by owner"); return 3
    until = parse(s.get("blocked_until"))
    if until and until > now():
        print(f"blocked until {iso(until)}: {s.get('blocked_reason')}"); return 3
    if until:
        s["blocked_until"] = None; s["blocked_reason"] = None
        log(s, "limit window passed; resuming")
        save(lane_path(a.lane), s)
    print("ok"); return 0


def cmd_next(a):
    s = load(lane_path(a.lane))
    items = load(BACKLOG)["items"]
    states = all_states()
    cur = s.get("current")
    if cur and states.get(cur, {}).get("state") in ("in_progress", "pr_open"):
        item = next(i for i in items if i["id"] == cur)
        print(json.dumps({**item, "resume": True, **states[cur]})); return 0
    for item in items:
        if item["lane"] != a.lane:
            continue
        st = states.get(item["id"], {})
        if st.get("state") in DONE or st.get("state") == "failed":
            continue
        if any(states.get(d, {}).get("state") != "merged" for d in item["deps"]):
            continue
        print(json.dumps({**item, "resume": False, **st})); return 0
    print("nothing ready"); return 4


def cmd_set(a):
    s = load(lane_path(a.lane))
    it = s["items"].setdefault(a.id, {"state": "queued", "attempts": 0})
    if a.state:
        if a.state == "in_progress" and it.get("state") != "in_progress":
            it["attempts"] = it.get("attempts", 0) + 1
            it.setdefault("started_at", iso(now()))
        it["state"] = a.state
        if it["attempts"] > MAX_ATTEMPTS and a.state == "in_progress":
            it["state"] = "failed"
    for k in ("branch", "pr", "verdict", "note"):
        v = getattr(a, k)
        if v is not None:
            it[k] = int(v) if k == "pr" else v
    it["updated_at"] = iso(now())
    s["current"] = a.id if it["state"] in ("in_progress", "pr_open") else None
    log(s, f"{a.id} -> {it['state']}" + (f" ({a.note})" if a.note else ""))
    s["last_run"] = iso(now())
    save(lane_path(a.lane), s)
    print(json.dumps(it))
    if it["state"] == "failed":
        return 1
    return 0


def cmd_block(a):
    s = load(lane_path(a.lane))
    until = parse(a.until) if a.until else now() + dt.timedelta(minutes=a.minutes)
    s["blocked_until"] = iso(until); s["blocked_reason"] = a.reason
    log(s, f"usage limit: paused until {iso(until)} ({a.reason})")
    save(lane_path(a.lane), s)
    print(iso(until)); return 0


def cmd_log(a):
    s = load(lane_path(a.lane)); log(s, a.msg); s["last_run"] = iso(now())
    save(lane_path(a.lane), s); return 0


def cmd_sync(a):
    sync(a.lane, a.message); return 0


def cmd_comment(a):
    issue = load(BACKLOG).get("trackingIssue")
    if not issue:
        print("no tracking issue configured"); return 0
    try:
        github("POST", f"/repos/{issue['repo']}/issues/{issue['number']}/comments",
               {"body": f"**{a.lane} lane** — {a.body}"})
    except Exception as e:  # monitoring must never break the lane
        print(f"comment failed: {e}")
    return 0


def cmd_pr(a):
    repo = load(BACKLOG)["repos"][a.repo]
    base = load(BACKLOG)["integrationBranch"]
    pr = github("POST", f"/repos/{repo}/pulls",
                {"title": a.title, "head": a.branch, "base": base, "body": open(a.body_file).read()})
    print(pr["number"]); return 0


def cmd_merge(a):
    repo = load(BACKLOG)["repos"][a.repo]
    pr = github("GET", f"/repos/{repo}/pulls/{a.pr}")
    if pr["base"]["ref"] != load(BACKLOG)["integrationBranch"]:
        raise SystemExit("refusing: autopilot merges only into the integration branch")
    github("PUT", f"/repos/{repo}/pulls/{a.pr}/merge", {"merge_method": "merge"})
    print("merged"); return 0


def cmd_status(a):
    states = all_states()
    for item in load(BACKLOG)["items"]:
        st = states.get(item["id"], {})
        print(f"{item['id']:6} {item['lane']:6} {st.get('state','queued'):12} {item['title']}")
    return 0


def main():
    p = argparse.ArgumentParser()
    sp = p.add_subparsers(dest="cmd", required=True)
    for name in ("gate", "next"):
        x = sp.add_parser(name); x.add_argument("--lane", required=True)
    x = sp.add_parser("set"); x.add_argument("--lane", required=True); x.add_argument("--id", required=True)
    x.add_argument("--state", choices=["queued", "in_progress", "pr_open", "merged", "failed", "skipped", "blocked"])
    for k in ("branch", "pr", "verdict", "note"):
        x.add_argument("--" + k)
    x = sp.add_parser("block"); x.add_argument("--lane", required=True); x.add_argument("--until")
    x.add_argument("--minutes", type=int, default=60); x.add_argument("--reason", default="usage limit")
    x = sp.add_parser("log"); x.add_argument("--lane", required=True); x.add_argument("--msg", required=True)
    x = sp.add_parser("sync"); x.add_argument("--lane", required=True); x.add_argument("--message", default="state")
    x = sp.add_parser("comment"); x.add_argument("--lane", required=True); x.add_argument("--body", required=True)
    x = sp.add_parser("pr"); x.add_argument("--repo", required=True); x.add_argument("--branch", required=True)
    x.add_argument("--title", required=True); x.add_argument("--body-file", required=True)
    x = sp.add_parser("merge"); x.add_argument("--repo", required=True); x.add_argument("--pr", required=True)
    sp.add_parser("status")
    a = p.parse_args()
    refresh()
    sys.exit(globals()["cmd_" + a.cmd](a))


if __name__ == "__main__":
    main()
