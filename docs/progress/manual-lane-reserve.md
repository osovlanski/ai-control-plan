# Manual lanes: reserve an item first (plan §C.2.2, §C.4)

A cloud thread or itay that takes a backlog item must reserve `os/<id>` before doing any work, with
the same create-ref call the plane uses. An ordinary `git push` is not create-if-absent and is
**not** a reservation.

1. `base` = the tip of `main` (`gh api repos/<owner>/<repo>/git/ref/heads/main --jq .object.sha`).
2. Build the commit: the base's tree, the base as the only parent, and exactly this message
   (author and committer name, email and date fixed; keep them identical on every retry):

   ```
   aos-reservation item=<id> lane=<lane> reservation=<uuid>
   ```

   `<lane>` is `manual-cloud` or `owner`. `<uuid>` is a fresh UUID you note in your first output.
3. `POST /repos/<owner>/<repo>/git/commits` with `{message, tree, parents: [base], author, committer}`.
4. `POST /repos/<owner>/<repo>/git/refs` with `{ref: "refs/heads/os/<id>", sha: <that commit>}`
   (or the GitHub MCP `create_branch`, which is the same call).
5. Outcome: **201** → you own it. **422** → read the ref and walk its first-parent history to the
   `aos-reservation` commit: yours (same `reservation=`) → owned; anything else → **stop**, the item
   belongs to another lane or the plane. Timeout or 5xx → re-read the ref first; absent → retry the
   create, present → apply the 422 rule.
6. Your PR's first commit is that reservation commit, so ownership stays recoverable from history.

The plane's autopilot treats any `os/<id>` it did not reserve as another lane's and never selects it.
