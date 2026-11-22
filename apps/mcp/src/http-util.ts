import type { IncomingMessage, ServerResponse } from "node:http";

export const MAX_BODY_BYTES = 256 * 1024;

export class BodyTooLarge extends Error {}

export async function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new BodyTooLarge("body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

export function sendHtml(res: ServerResponse, status: number, title: string, inner: string, headers: Record<string, string> = {}) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
    // The consent page must never be framed (clickjacking) and loads nothing external.
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    "x-frame-options": "DENY", "referrer-policy": "no-referrer", ...headers,
  });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem;color:#111;background:#fff}
@media (prefers-color-scheme: dark){body{color:#eee;background:#111}} button{font:inherit;padding:.6rem 1.2rem;margin-right:.5rem} code{word-break:break-all}</style></head>
<body><h1>${escapeHtml(title)}</h1>${inner}</body></html>`);
}

export function redirect(res: ServerResponse, location: string, status = 302, headers: Record<string, string> = {}) {
  res.writeHead(status, { location, "cache-control": "no-store", "referrer-policy": "no-referrer", ...headers });
  res.end();
}

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
