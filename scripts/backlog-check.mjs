#!/usr/bin/env node
// backlog-check: validates docs/progress/backlog.yaml (auto copilot plan §C.3, slice P0-9).
//
//   node scripts/backlog-check.mjs [path/to/backlog.yaml] [--digests]
//
// Exit 0 when the backlog is valid, 1 when it is not, 2 on a usage or read error.
// Enum values and required fields come from docs/progress/backlog.schema.json, so the
// schema and this check cannot drift. The cross-item rules the schema cannot express
// (unique ids, depends_on targets, cycles, offline installs) live only here.
// --digests prints one "<id> <sha256>" line per item: the revision digest of §C.3.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// pnpm keeps dependencies per package; the api package already depends on `yaml`.
const { parse: parseYaml } = createRequire(path.join(repoRoot, "apps/api/package.json"))("yaml");
const schema = JSON.parse(readFileSync(path.join(repoRoot, "docs/progress/backlog.schema.json"), "utf8"));
const defs = schema.$defs;

const ITEM_KEYS = Object.keys(defs.item.properties);
const ITEM_REQUIRED = defs.item.required;
const ACCEPTANCE_KEYS = Object.keys(defs.acceptance.properties);
const COMMAND_KEYS = Object.keys(defs.command.properties);
const ID_RE = new RegExp(defs.id.pattern);
const ID_MAX = defs.id.maxLength;
const REPOS = defs.item.properties.repo.enum;
const SIZES = defs.item.properties.size.enum;
const LANES = defs.item.properties.lane.enum;
const TIMEOUT_MAX = defs.command.properties.timeoutSec.maximum;
const SIZE_POINTS = { S: 1, M: 3, L: 8 };
// A dependency install inside an offline snapshot must not reach a registry (§C.2.7 step 4).
const INSTALL_RE = /\b(pnpm|npm|yarn)\s+(install|i|ci|add)\b/;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string" && v.trim().length > 0;

function relPathError(p) {
  if (!isStr(p)) return "must be a non-empty string";
  if (path.isAbsolute(p) || p.startsWith("~")) return "must be repository-relative";
  const segs = p.replace(/\/+$/, "").split("/");
  if (segs.includes("..")) return "must not contain '..'";
  if (segs.join("/") === "." || segs.join("/") === "" || p === "*" || p === "**") return "must not be the repository root";
  if (segs[0] === ".git") return "must not be under .git";
  return null;
}

function unknownKeys(obj, allowed, where, errors) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) errors.push(`${where}: unknown field '${k}'`);
}

function checkAcceptance(acc, where, errors) {
  if (!isObj(acc)) return errors.push(`${where}: must be an object`);
  unknownKeys(acc, ACCEPTANCE_KEYS, where, errors);
  if (!Array.isArray(acc.commands) || acc.commands.length === 0) errors.push(`${where}.commands: must be a non-empty list`);
  else
    acc.commands.forEach((c, i) => {
      const w = `${where}.commands[${i}]`;
      if (!isObj(c)) return errors.push(`${w}: must be an object with run and replaySafe`);
      unknownKeys(c, COMMAND_KEYS, w, errors);
      if (!isStr(c.run)) errors.push(`${w}.run: must be a non-empty string`);
      if (typeof c.replaySafe !== "boolean") errors.push(`${w}.replaySafe: must be set explicitly to true or false`);
      if (c.timeoutSec !== undefined && !(Number.isInteger(c.timeoutSec) && c.timeoutSec >= 1 && c.timeoutSec <= TIMEOUT_MAX))
        errors.push(`${w}.timeoutSec: must be an integer from 1 to ${TIMEOUT_MAX}`);
      if (isStr(c.run) && INSTALL_RE.test(c.run) && !/--offline\b/.test(c.run))
        errors.push(`${w}.run: a dependency install must pass --offline (acceptance has no network)`);
    });
  if (!Array.isArray(acc.writable) || acc.writable.length === 0) errors.push(`${where}.writable: must be a non-empty list`);
  else {
    // A string is a directory; {file: path} is one file that may not exist yet (P0-4's runner shape).
    const keys = acc.writable.map((w, i) => {
      if (isObj(w)) {
        unknownKeys(w, ["file"], `${where}.writable[${i}]`, errors);
        const e = relPathError(w.file);
        if (e) errors.push(`${where}.writable[${i}].file: ${e}`);
        return `file:${w.file}`;
      }
      const e = relPathError(w);
      if (e) errors.push(`${where}.writable[${i}]: ${e}`);
      return `dir:${w}`;
    });
    if (new Set(keys).size !== keys.length) errors.push(`${where}.writable: duplicate path`);
  }
  if (acc.drive !== undefined && !isStr(acc.drive)) errors.push(`${where}.drive: must be a non-empty string`);
}

function checkItem(item, i, errors) {
  const where = `items[${i}]${isObj(item) && isStr(item.id) ? ` (${item.id})` : ""}`;
  if (!isObj(item)) return errors.push(`${where}: must be an object`);
  unknownKeys(item, ITEM_KEYS, where, errors);
  for (const k of ITEM_REQUIRED) if (item[k] === undefined) errors.push(`${where}: missing '${k}'`);
  if (item.id !== undefined && !(typeof item.id === "string" && ID_RE.test(item.id) && item.id.length <= ID_MAX))
    errors.push(`${where}.id: must match ${defs.id.pattern} and be at most ${ID_MAX} characters`);
  for (const k of ["title", "phase", "profile", "source", "notes"])
    if (item[k] !== undefined && !isStr(item[k])) errors.push(`${where}.${k}: must be a non-empty string`);
  if (item.repo !== undefined && !REPOS.includes(item.repo)) errors.push(`${where}.repo: one of ${REPOS.join(", ")}`);
  if (item.size !== undefined && !SIZES.includes(item.size)) errors.push(`${where}.size: one of ${SIZES.join(", ")}`);
  if (item.lane !== undefined && !LANES.includes(item.lane)) errors.push(`${where}.lane: one of ${LANES.join(", ")}`);
  if (item.night !== undefined && typeof item.night !== "boolean") errors.push(`${where}.night: must be true or false`);
  if (item.depends_on !== undefined) {
    if (!Array.isArray(item.depends_on)) errors.push(`${where}.depends_on: must be a list`);
    else if (new Set(item.depends_on).size !== item.depends_on.length) errors.push(`${where}.depends_on: duplicate id`);
  }
  if (item.files !== undefined) {
    if (!Array.isArray(item.files) || item.files.length === 0) errors.push(`${where}.files: must be a non-empty list`);
    else
      item.files.forEach((p, j) => {
        const e = relPathError(p);
        if (e) errors.push(`${where}.files[${j}]: ${e}`);
      });
  }
  if (item.lane === "oci-loop" && item.acceptance === undefined)
    errors.push(`${where}.acceptance: required for lane oci-loop (commands with replaySafe, and writable paths)`);
  if (item.acceptance !== undefined) checkAcceptance(item.acceptance, `${where}.acceptance`, errors);
}

function checkGraph(items, errors) {
  const ids = new Map();
  items.forEach((it, i) => {
    if (!isObj(it) || typeof it.id !== "string") return;
    if (ids.has(it.id)) errors.push(`items[${i}].id: duplicate id '${it.id}' (first at items[${ids.get(it.id)}])`);
    else ids.set(it.id, i);
  });
  // First occurrence wins, so a duplicate cannot hide the original's dependencies.
  const byId = new Map([...ids].map(([id, i]) => [id, items[i]]));
  for (const it of byId.values()) {
    for (const d of Array.isArray(it.depends_on) ? it.depends_on : []) {
      if (d === it.id) errors.push(`${it.id}.depends_on: depends on itself`);
      else if (!byId.has(d)) errors.push(`${it.id}.depends_on: unknown id '${d}'`);
    }
  }
  // Cycle detection, iterative DFS with colours.
  const colour = new Map();
  for (const start of byId.keys()) {
    if (colour.get(start)) continue;
    const stack = [[start, 0]];
    const trail = [];
    while (stack.length) {
      const top = stack[stack.length - 1];
      const [id, k] = top;
      if (k === 0) {
        colour.set(id, 1);
        trail.push(id);
      }
      const deps = (byId.get(id)?.depends_on ?? []).filter((d) => byId.has(d) && d !== id);
      if (k < deps.length) {
        top[1] = k + 1;
        const next = deps[k];
        if (colour.get(next) === 1) {
          errors.push(`depends_on cycle: ${[...trail.slice(trail.indexOf(next)), next].join(" -> ")}`);
        } else if (!colour.get(next)) stack.push([next, 0]);
      } else {
        colour.set(id, 2);
        trail.pop();
        stack.pop();
      }
    }
  }
}

// Canonical JSON (sorted keys) so the digest ignores YAML layout and key order.
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
export const itemDigest = (item) => createHash("sha256").update(canonical(item)).digest("hex");

export function checkBacklog(doc) {
  const errors = [];
  if (!isObj(doc)) return { errors: ["backlog: top level must be a mapping with version and items"], items: [] };
  unknownKeys(doc, Object.keys(schema.properties), "backlog", errors);
  if (doc.version !== 1) errors.push("backlog.version: must be 1");
  if (!Array.isArray(doc.items) || doc.items.length === 0) {
    errors.push("backlog.items: must be a non-empty list");
    return { errors, items: [] };
  }
  doc.items.forEach((it, i) => checkItem(it, i, errors));
  checkGraph(doc.items, errors);
  return { errors, items: doc.items };
}

function main(argv) {
  const args = argv.filter((a) => !a.startsWith("--"));
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  for (const f of flags) if (f !== "--digests") return usage(`unknown flag ${f}`);
  if (args.length > 1) return usage("at most one backlog path");
  const file = path.resolve(args[0] ?? path.join(repoRoot, "docs/progress/backlog.yaml"));
  let doc;
  try {
    doc = parseYaml(readFileSync(file, "utf8"), { uniqueKeys: true });
  } catch (err) {
    console.error(`backlog-check: cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  const { errors, items } = checkBacklog(doc);
  if (errors.length) {
    for (const e of errors) console.error(`backlog-check: ${e}`);
    console.error(`backlog-check: FAIL, ${errors.length} error(s) in ${file}`);
    return 1;
  }
  if (flags.has("--digests")) for (const it of items) console.log(`${it.id} ${itemDigest(it)}`);
  const count = (pred) => items.filter(pred).length;
  const lanes = LANES.map((l) => `${l} ${count((it) => it.lane === l)}`).join(", ");
  const points = items.reduce((n, it) => n + SIZE_POINTS[it.size], 0);
  console.log(`backlog-check: PASS, ${items.length} items (${lanes}); ${points} estimated scope points; ${count((it) => it.night)} night-eligible`);
  return 0;
}

function usage(msg) {
  console.error(`backlog-check: ${msg}\nusage: node scripts/backlog-check.mjs [backlog.yaml] [--digests]`);
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
