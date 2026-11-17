# Autopilot backup and restore runbook

How to back up the plane database, restore it, and get the autopilot running again
(`docs/agentic-os-auto-copilot-plan.md` §C.5). Every command runs as the plane user from the
repo checkout the plane runs from. `$OP` is the `autopilot.operate` secret, typed with
`read -rs OP` and never written to a file, a log or this repo. `$CRED` is an ordinary API
credential. The API listens on loopback only.

Not built yet: the nightly backup timer, the off-host destination (D-11, an encrypted OCI bucket)
and the replacement-host drill with token and secret rotation. Until they exist, back up by hand
before a window and copy the file off the box yourself.

## 1. Back up

```sh
pnpm --filter @agent-plane/api backup                 # online; the plane keeps running
pnpm --filter @agent-plane/api backup -- list
```

The copy is integrity-checked and lands in `autopilot.backup.localDir` (default
`<workspace>/backups`) with a sha256 manifest. Copies older than `keepDays` (7) are pruned. With
`autopilot.backup.destination: dir:/abs/path` the copy is also put there.

## 2. Restore

1. Stop the plane (`systemctl --user stop agent-plane-operator`, or stop `pnpm dev`). The
   restore refuses while any process holds the database open.
2. Restore:

   ```sh
   pnpm --filter @agent-plane/api backup -- restore --from latest     # or --from <file.db>
   ```

   It checks the copy against its manifest, writes `restored_at.json` **first**, moves the current
   database aside as `<db>.pre-restore-<stamp>` (never deleted) and puts the copy in place.
3. Start the plane. It records the restore, stops the autopilot (`stop_reason: restored`), runs
   one reconciliation and treats every window that was open as exhausted: nothing launches in it,
   even after a start.

## 3. Reconcile and read the report

```sh
curl -s -H "Authorization: Bearer $CRED" localhost:<port>/api/autopilot/restore       # summary
curl -s -X POST -H "Authorization: Bearer $OP" localhost:<port>/api/autopilot/restore/reconcile
curl -s -H "Authorization: Bearer $OP" localhost:<port>/api/autopilot/restore/report
```

- `reportComplete: false` means GitHub (or another section) could not be read. Fix that and
  reconcile again; an incomplete report never unlocks a start.
- Reading the report through `autopilot.operate` is what unlocks a start. A newer reconciliation
  needs a new read.
- Orphan worktrees are moved to `<root>/.quarantine/<restore id>/` (0700). Nothing deletes them;
  look through them and remove them by hand when you are sure.
- A `running` attempt whose session did not survive is now `suspended` and resumes in a later
  window.
- If the agent slice is not empty, the host gate stays closed until those processes exit.

## 4. Decide on external records

An external record is an `os/*` reservation or an `aos-publication` PR that the restored database
does not know. Its item is reported `blocked` and is never re-run until you decide.

```sh
curl -s -H "Authorization: Bearer $CRED" localhost:<port>/api/autopilot/externals          # ?all=1 adds dismissed ones
curl -s -X POST -H "Authorization: Bearer $OP" -H 'content-type: application/json' \
  -d '{"action":"dismiss","note":"why"}' localhost:<port>/api/autopilot/externals/<id>/resolve
```

Before you dismiss a reservation, look at the ref on GitHub. If it holds work you want, open a PR
from it by hand. If not, delete the ref. Dismissing does not touch GitHub: while `os/<id>` still
exists the dispatcher reports the item as held or blocked and does not select it. Once the ref is
gone (or its PR merged) the item becomes eligible again. A later restore that finds the same
record again reopens it. Unresolved records are listed in the morning report under unresolved
remote effects.

## 5. Start again

```sh
curl -s -X POST -H "Authorization: Bearer $OP" localhost:<port>/api/autopilot/start
```

The start clears the restore. Add a new window (`POST /api/autopilot/windows`) if the only open
one is exhausted by the restore.
