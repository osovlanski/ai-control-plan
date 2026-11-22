/**
 * Remote mode (B2) as the browser sees it. On the private Web link the plane answers
 * `GET /api/auth/session` with the remote session and its CSRF token; on the local listener that
 * route does not exist, so the app keeps today's local behaviour. The CSRF token lives only in this
 * module's memory: never in storage, a cookie JavaScript can read, or a URL.
 */
export type AuthMode = "local" | "remote" | "signin";

interface RemoteSession { csrfToken: string | null; idleExpiresAt: string; expiresAt: string; idleTtlSeconds: number }

let session: RemoteSession | null = null;
let remote = false;
const RETURN_KEY = "acp.remote.returnHash";
const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const isRemoteMode = () => remote;

/** Probes the plane once at startup. Network failure is "local": the local app shows its own errors. */
export async function loadAuthMode(): Promise<AuthMode> {
  let res: Response;
  try { res = await fetch("/api/auth/session", { credentials: "include", cache: "no-store" }); } catch { return "local"; }
  if (res.ok) {
    const body = (await res.json().catch(() => ({}))) as Partial<RemoteSession> & { mode?: string };
    if (body.mode !== "remote") return "local";
    remote = true;
    session = { csrfToken: body.csrfToken ?? null, idleExpiresAt: body.idleExpiresAt ?? "", expiresAt: body.expiresAt ?? "", idleTtlSeconds: body.idleTtlSeconds ?? 0 };
    restoreReturnHash();
    return "remote";
  }
  if (res.status === 401) {
    const body = (await res.json().catch(() => ({}))) as { mode?: string };
    if (body.mode === "remote") { remote = true; session = null; return "signin"; }
  }
  return "local";
}

/** Headers an unsafe request needs on the remote listener. Empty in local mode. */
export function csrfHeaders(method: string | undefined): Record<string, string> {
  if (!remote || !session?.csrfToken || !UNSAFE.has((method ?? "GET").toUpperCase())) return {};
  return { "x-csrf-token": session.csrfToken };
}

/** Top-level navigation to the plane's login. The current screen is restored after the round trip. */
export function startSignIn(): void {
  try { if (location.hash && location.hash !== "#/") sessionStorage.setItem(RETURN_KEY, location.hash); } catch { /* storage may be blocked */ }
  location.assign("/api/auth/login");
}

function restoreReturnHash(): void {
  try {
    const hash = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    // Only an in-app hash route is restored (never a URL).
    if (hash && /^#\/[A-Za-z0-9/_\-.%]*$/.test(hash)) location.hash = hash;
  } catch { /* storage may be blocked */ }
}

export async function signOut(): Promise<void> {
  try { await fetch("/api/auth/logout", { method: "POST", credentials: "include", headers: csrfHeaders("POST") }); } finally { session = null; }
}

let lastActivity = 0;
/**
 * Real operator interaction keeps the session from idling out; polling and streams never do.
 * At most one ping a minute.
 */
export function noteActivity(now = Date.now()): void {
  if (!remote || !session || now - lastActivity < 60_000) return;
  lastActivity = now;
  void fetch("/api/auth/activity", { method: "POST", credentials: "include", headers: csrfHeaders("POST") }).catch(() => undefined);
}

/** Test hook. */
export function resetRemoteAuthForTest(): void { session = null; remote = false; lastActivity = 0; }
