#!/usr/bin/env node
// morning-report: prints the autopilot's minimum morning report (auto copilot plan P0-10).
//
//   node scripts/morning-report.mjs [--url http://127.0.0.1:4176] [--window <id>] [--json] [--token-file <path>] [--scope [--day YYYY-MM-DD]]
//
// It reads GET /api/autopilot/report on a running plane (the numbers come from the plane's DB,
// through the same accounting as the budget route), so it holds no SQL of its own. The bearer is
// a credential with `tasks.read`: from --token-file (one line), else AGENT_PLANE_TOKEN. It is
// never printed. --scope adds P1-2's "% of estimated scope" (GET /api/autopilot/scope: S=1, M=3, L=8
// points, merged PRs count as done) after the report; with --json the output is then {report, scope}.
// Exit 0 on a report, 1 when the plane answers with an error, 2 on a usage error.
import { readFileSync } from "node:fs";
import process from "node:process";
import console from "node:console";
import { URL } from "node:url";

const { fetch } = globalThis;

const args = process.argv.slice(2);
const opts = { url: process.env.AGENT_PLANE_URL ?? "http://127.0.0.1:4176", json: false, scope: false };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--json") opts.json = true;
  else if (a === "--scope") opts.scope = true;
  else if (a === "--url" || a === "--window" || a === "--token-file" || a === "--day") {
    const v = args[++i];
    if (!v) { console.error(`${a} needs a value`); process.exit(2); }
    opts[a.slice(2).replace("-file", "File")] = v;
  } else if (a === "--help" || a === "-h") {
    console.log("Usage: node scripts/morning-report.mjs [--url <plane>] [--window <id>] [--json] [--token-file <path>] [--scope [--day YYYY-MM-DD]]");
    process.exit(0);
  } else { console.error(`unknown argument ${a}`); process.exit(2); }
}

let token = process.env.AGENT_PLANE_TOKEN;
if (opts.tokenFile) {
  try { token = readFileSync(opts.tokenFile, "utf8").trim(); } catch (err) { console.error(`cannot read --token-file: ${err.code ?? err.message}`); process.exit(2); }
}
if (!token) { console.error("no credential: pass --token-file or set AGENT_PLANE_TOKEN"); process.exit(2); }

const url = new URL("/api/autopilot/report", opts.url);
if (opts.window) url.searchParams.set("windowId", opts.window);
if (!opts.json) url.searchParams.set("format", "text");

let res;
try { res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, redirect: "error" }); } catch (err) {
  console.error(`cannot reach ${url.origin}: ${err.cause?.code ?? err.message}`);
  process.exit(1);
}
const body = await res.text();
if (!res.ok) { console.error(`plane answered ${res.status}: ${body}`); process.exit(1); }
if (!opts.scope) {
  process.stdout.write(opts.json ? `${JSON.stringify(JSON.parse(body), null, 2)}\n` : `${body}\n`);
  process.exit(0);
}

// P1-2: the report always prints; a scope that cannot be read is said so and exits 1 after it.
const scopeUrl = new URL("/api/autopilot/scope", opts.url);
if (opts.day) scopeUrl.searchParams.set("day", opts.day);
if (!opts.json) scopeUrl.searchParams.set("format", "text");
let scopeBody;
let scopeError;
try {
  const r = await fetch(scopeUrl, { headers: { authorization: `Bearer ${token}` }, redirect: "error" });
  scopeBody = await r.text();
  if (!r.ok) scopeError = `plane answered ${r.status}: ${scopeBody}`;
} catch (err) { scopeError = `cannot reach ${scopeUrl.origin}: ${err.cause?.code ?? err.message}`; }
if (opts.json) {
  process.stdout.write(`${JSON.stringify({ report: JSON.parse(body), scope: scopeError ? { error: scopeError } : JSON.parse(scopeBody) }, null, 2)}\n`);
} else {
  process.stdout.write(`${body}\n\n${scopeError ? `Scope (estimate): not available (${scopeError})` : scopeBody}\n`);
}
if (scopeError) { console.error(`scope: ${scopeError}`); process.exit(1); }
