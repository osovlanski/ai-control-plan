# Open the web UI from a headless OCI server

The API and browser bootstrap bind to loopback. Reach them through SSH; no
`xdg-open`, desktop session, public listener or firewall change is needed.

## Start services on the server

Start a persistent tmux session with `tmux new -s agent-plane` (or use an
existing session). Inside it:

```bash
cd ~/workspace/personal/ai-control-plan
pnpm install --frozen-lockfile
pnpm build                       # lets the API serve the built UI after bootstrap
pnpm dev
```

The normal ports are API `127.0.0.1:4176` and Vite web
`127.0.0.1:5176`. Keep the same `AGENT_PLANE_HOME` and
`AGENT_PLANE_WORKSPACE` settings for the services and launcher.

## Request a bootstrap page

In another server shell or tmux pane, from the repository:

```bash
pnpm --filter @agent-plane/api open --headless
```

The command prints a URL such as `http://127.0.0.1:38203` and an SSH command.
It waits up to **300 seconds (five minutes)** for the browser's first `GET /`.
Keep the command running while arranging the tunnel. No browser utility is
invoked. The default port is randomly assigned by the OS to avoid collisions.

On the Mac, create the forwards, replacing the example bootstrap port with
**the port printed by this invocation**, and `<ssh-host>` with your SSH alias
or `<user>@<host>`:

```bash
ssh -N -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:4176:127.0.0.1:4176 \
  -L 127.0.0.1:5176:127.0.0.1:5176 \
  -L 127.0.0.1:38203:127.0.0.1:38203 \
  <ssh-host>
```

If the normal 4176/5176 forwards already exist, add only the printed bootstrap
forward in another SSH connection. Then open the printed URL **on the Mac**.
Use `127.0.0.1`, and preserve the same local and remote bootstrap port: the
signed token is bound to that exact browser origin. Changing the local port
or substituting `localhost` fails closed. If the local port is occupied,
choose another port on the server with `--port` and run the command again.

The bootstrap page auto-submits a form to `http://127.0.0.1:4176/api/auth/bootstrap`.
The API installs the browser's session cookie and redirects to its built UI at
`http://127.0.0.1:4176/`. For development, subsequently visit
`http://127.0.0.1:5176/` in the same browser; Vite proxies `/api` to 4176 and the
host-scoped cookie also works there. `pnpm build` is needed for the API's
landing page, but Vite serves development source separately.

The bootstrap port is separate because it serves one temporary credential
exchange page; the API and web ports remain available for the ongoing session.
Once the page is delivered, its listener closes. The bootstrap forward may
remain configured, but it cannot create another session until `open` runs again.

## Optional permanent SSH configuration

Choose a bootstrap port, for example 8787. On the Mac:

```sshconfig
Host ai-control-plane
    HostName <server-hostname>
    User <user>
    IdentityFile <path-to-private-key>
    ExitOnForwardFailure yes
    LocalForward 127.0.0.1:5176 127.0.0.1:5176
    LocalForward 127.0.0.1:4176 127.0.0.1:4176
    LocalForward 127.0.0.1:8787 127.0.0.1:8787
```

Connect with `ssh ai-control-plane` and, on the server, run:

```bash
pnpm --filter @agent-plane/api open --headless --port 8787
```

Open `http://127.0.0.1:8787` locally. A busy server port fails with an explicit
error; it does not silently select another port. Omit `--port` (or use `--port 0`)
for an ephemeral port. Do not start a duplicate local forward if SSH config
already supplies it.

## Lifetime and security

- `--wait-seconds <integer>` controls only the listener's wait, from **1 to 900
  seconds**, default 300. Example: `open --headless --wait-seconds 600`.
- The printed URL contains **no token or long-lived credential**. Treat it as
  operator-only while active: a process able to reach the loopback listener
  can request its one page. Loopback is transport scope; this is not an
  authenticated multi-user remote mode.
- The signed bootstrap token is minted **when the browser requests the page**,
  with the existing `api.auth.bootstrapTtlSeconds` (default **10 seconds**).
  Waiting for SSH does not age the token. Its lifetime is not extended by
  `--wait-seconds`. The token stays in the form body, never the URL or CLI output.
- The launcher delivers one page and closes after flushing it. It cannot observe
  whether the subsequent API exchange succeeded. A failed exchange requires a
  new `open` command. Avoid `curl /`, link previews or browser prefetch on the
  live URL before the intended browser request. `curl -I` does not consume it
  (it returns 410); `ss -ltnp` can inspect the listener without requesting a page.
- The API verifies signature, audience, exact launcher origin, expiry and active
  signing credential. Its persistent one-time token ID prevents replay, even
  after API restart. Sessions retain `HttpOnly; Secure; SameSite=Strict; Path=/`
  and the existing session TTL (default 12 hours) and rotation semantics.
- The launcher validates browser capabilities before binding and again before
  issuing the token, including after credential rotation. `--read-only` requests
  all browser read capabilities without `commands.write`; missing required read
  capabilities still fail. An older credential may need the existing `rotate`
  workflow to grant newly introduced browser capabilities.
- Unused listeners terminate at the deadline, including stalled HTTP connections.
  Ctrl-C or SIGTERM also closes them. A timed-out request cannot mint a token.
- Plain `open` still launches the desktop browser when available. On Linux with
  neither `DISPLAY` nor `WAYLAND_DISPLAY`, it automatically uses headless mode.
  Browser spawn errors (including ENOENT) and nonzero exits print a warning and
  leave the bounded listener usable. Credential, option and bind failures still
  fail the command.
- `--origin` remains an advanced API-origin override, not a redirect destination.
  It must match the API's configured origin for audience verification. Do not
  point it at the Vite port or change API forwarding ports to avoid a collision.
  The standard flow needs no override.

If five minutes elapse, run `open` again. With an ephemeral port, update the
bootstrap forward to the newly printed port; with `--port 8787`, reuse the
existing forward. No session is created merely by starting a listener.
