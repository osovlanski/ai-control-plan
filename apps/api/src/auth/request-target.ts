import type { FastifyRequest } from "fastify";

/**
 * C1 (security review 2026-11-24): whether a request is an API request is decided from what the
 * router matched, never from the raw request target. find-my-way routes on the decoded path, so a
 * raw `startsWith("/api/")` test let `/%61pi/tasks` reach `/api/tasks` with no credential and
 * past the listener split.
 */

/** Only origin-form targets (`/path?query`) are served. Absolute-form and `*` are refused before auth. */
export function isOriginForm(rawUrl: string | undefined): boolean {
  return typeof rawUrl === "string" && rawUrl.startsWith("/");
}

/**
 * The path as a lenient reader would see it: percent escapes decoded until stable, duplicate
 * slashes collapsed, dot segments resolved, lower case. Used only to fail closed on requests the
 * router did not match. Undecodable input returns undefined, which callers treat as an API path.
 */
export function normalizedPath(rawUrl: string): string | undefined {
  let p = rawUrl.split("?")[0]!.split("#")[0]!;
  try {
    for (let i = 0; i < 4 && p.includes("%"); i++) { const next = decodeURIComponent(p); if (next === p) break; p = next; }
    if (p.includes("%")) return undefined;
  } catch { return undefined; }
  p = p.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  const out: string[] = [];
  for (const seg of p.split("/").slice(1)) {
    if (seg === ".") continue;
    if (seg === "..") { out.pop(); continue; }
    out.push(seg);
  }
  return `/${out.join("/")}`.toLowerCase();
}

const underApi = (p: string) => p === "/api" || p.startsWith("/api/");

/** True when the route the router matched is an API route, or, unmatched, when the target could be read as one. */
export function isApiRequest(req: FastifyRequest): boolean {
  const route = req.routeOptions.url;
  if (route) return underApi(route);
  const p = normalizedPath(req.url);
  return p === undefined || underApi(p);
}
