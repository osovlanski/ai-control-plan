/**
 * qcq-04a: the provider-entry call-site allowlist (review packet 2.4.2), on the TypeScript syntax
 * tree with the type checker, not on source text. A comment naming `adapter.start()` is not a call;
 * a renamed receiver still resolves to `AgentAdapter.start`.
 *
 * Pinned declarations, plus every class method that implements `AgentAdapter`:
 *   AgentAdapter.start / .resume, HarnessBridge.start / .startRequest, SessionRunner.start / .run,
 *   RunContext.startProvider.
 * The test asserts the exact inventory of matched calls in apps/api/src, and that each credentialed
 * adapter call is preceded, in its block, by the guarded commit:
 *   const entry = enterProvider(...);   // or store.enterProvider(...)
 *   if (!entry.ok) throw ... | return ...;
 * (or the one-statement form `if (!enterProvider(...).ok) throw|return`).
 */
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";

const API = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(API, "src");
const FIXTURE = join(SRC, "__qcq_allowlist_fixture__.ts");
// A virtual file, never written to disk. Each function exercises one rule of the scan.
const FIXTURE_TEXT = `import type { AgentAdapter, RunSpec } from "@agent-plane/core";
import type { Db } from "./db/index.js";
import { enterProvider } from "./modules/attempts.js";
// A comment naming adapter.start(spec) is not a call.
export async function renamed(adapter: AgentAdapter, spec: RunSpec) { const a = adapter; return a.start(spec); }
export async function unguarded(db: Db, adapter: AgentAdapter, spec: RunSpec) { enterProvider(db, { path: "legacy" }); return adapter.start(spec); }
export async function ignored(db: Db, adapter: AgentAdapter, spec: RunSpec) { const entry = enterProvider(db, { path: "legacy" }); void entry; return adapter.start(spec); }
export async function guarded(db: Db, adapter: AgentAdapter, spec: RunSpec) { const entry = enterProvider(db, { path: "legacy" }); if (!entry.ok) throw new Error(entry.reason); return adapter.start(spec); }
export async function inline(db: Db, adapter: AgentAdapter, spec: RunSpec) { if (!enterProvider(db, { path: "legacy" }).ok) return undefined; return adapter.resume("r" as never, spec); }
export async function destructured(adapter: AgentAdapter, spec: RunSpec) { const { start } = adapter; return start(spec); }
export async function bracket(adapter: AgentAdapter, spec: RunSpec) { return adapter["start"](spec); }
export async function aliased(adapter: AgentAdapter, spec: RunSpec) { const s = adapter.resume; return s("r" as never, spec); }
export async function guardedBracket(db: Db, adapter: AgentAdapter, spec: RunSpec) { const entry = enterProvider(db, { path: "legacy" }); if (!entry.ok) throw new Error(entry.reason); return adapter["start"](spec); }
`;

type Kind = "adapter" | "bridge" | "runner" | "startProvider";
interface Site { file: string; fn: string; text: string; kind: Kind; guarded: boolean; node: ts.CallExpression }

let program: ts.Program;
let checker: ts.TypeChecker;

beforeAll(() => {
  const parsed = ts.getParsedCommandLineOfConfigFile(join(API, "tsconfig.json"), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })!;
  const roots = parsed.fileNames.filter((f) => f.startsWith(SRC + "/"));
  const host = ts.createCompilerHost(parsed.options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, lang, ...rest) => name === FIXTURE ? ts.createSourceFile(name, FIXTURE_TEXT, lang) : getSourceFile(name, lang, ...rest);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) => name === FIXTURE || fileExists(name);
  const readFile = host.readFile.bind(host);
  host.readFile = (name) => name === FIXTURE ? FIXTURE_TEXT : readFile(name);
  program = ts.createProgram({ rootNames: [...roots, FIXTURE], options: parsed.options, host });
  checker = program.getTypeChecker();
}, 120_000);

const nameOf = (n: ts.Node | undefined): string | undefined =>
  n && (ts.isClassDeclaration(n) || ts.isInterfaceDeclaration(n)) ? n.name?.text : undefined;

/** Does this class declare `implements AgentAdapter` (resolved by the checker)? */
function implementsAdapter(c: ts.ClassDeclaration): boolean {
  for (const clause of c.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ImplementsKeyword) continue;
    for (const t of clause.types) {
      let s = checker.getSymbolAtLocation(t.expression);
      if (s && s.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s);
      if (s?.name === "AgentAdapter") return true;
    }
  }
  return false;
}

const MEMBERS = ["start", "resume", "startRequest", "run", "startProvider"];

/**
 * The member symbol a callee resolves to, whatever its syntax (#264 review: the scan missed
 * `adapter["start"](spec)` and `const { start } = adapter; start(spec)`): a property access, an
 * element access with a literal key, a destructured binding, or a local initialised from one of them.
 */
function resolveMember(callee: ts.Expression, depth = 0): ts.Symbol | undefined {
  if (depth > 4) return undefined;
  while (ts.isParenthesizedExpression(callee) || ts.isNonNullExpression(callee) || ts.isAsExpression(callee)) callee = callee.expression;
  if (ts.isPropertyAccessExpression(callee)) return checker.getSymbolAtLocation(callee.name);
  if (ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)) {
    return checker.getPropertyOfType(checker.getTypeAtLocation(callee.expression), callee.argumentExpression.text);
  }
  if (ts.isIdentifier(callee)) {
    let s = checker.getSymbolAtLocation(callee);
    if (s && s.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s);
    for (const d of s?.declarations ?? []) {
      if (ts.isBindingElement(d) && ts.isObjectBindingPattern(d.parent)) {
        const key = d.propertyName && (ts.isIdentifier(d.propertyName) || ts.isStringLiteralLike(d.propertyName)) ? d.propertyName.text : ts.isIdentifier(d.name) ? d.name.text : undefined;
        if (key) return checker.getPropertyOfType(checker.getTypeAtLocation(d.parent), key);
      }
      if (ts.isVariableDeclaration(d) && d.initializer) return resolveMember(d.initializer, depth + 1);
    }
  }
  return undefined;
}

/** Which pinned declaration (or implementation of one) a call resolves to, by symbol. */
function classify(call: ts.CallExpression): Kind | undefined {
  const sym = resolveMember(call.expression);
  const member = sym?.name;
  if (!member || !MEMBERS.includes(member)) return undefined;
  for (const d of sym?.declarations ?? []) {
    const owner = d.parent;
    const owned = nameOf(owner);
    if ((member === "start" || member === "resume") && (
      (ts.isInterfaceDeclaration(owner) && owned === "AgentAdapter") || (ts.isClassDeclaration(owner) && implementsAdapter(owner)))) return "adapter";
    if (owned === "HarnessBridge" && (member === "start" || member === "startRequest")) return "bridge";
    if (owned === "SessionRunner" && (member === "start" || member === "run")) return "runner";
    if (owned === "RunContext" && member === "startProvider") return "startProvider";
  }
  return undefined;
}

/** Is `call` (an expression or a function argument) a call to either `enterProvider`? */
function isCommit(e: ts.Expression | undefined): boolean {
  if (!e || !ts.isCallExpression(e)) return false;
  const target = ts.isPropertyAccessExpression(e.expression) ? e.expression.name : e.expression;
  let s = checker.getSymbolAtLocation(target);
  if (s && s.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s);
  if (s?.name !== "enterProvider") return false;
  return (s.declarations ?? []).some((d) => {
    const file = d.getSourceFile().fileName;
    return file.endsWith("/modules/attempts.ts") || (file.endsWith("/harness/session-store.ts") && nameOf(d.parent) === "SessionStore");
  });
}

/** `!X.ok`, where X is `enterProvider(...)` or an identifier named in `ids`. */
function negatesOk(cond: ts.Expression, id?: string): boolean {
  if (!ts.isPrefixUnaryExpression(cond) || cond.operator !== ts.SyntaxKind.ExclamationToken) return false;
  const inner = cond.operand;
  if (!ts.isPropertyAccessExpression(inner) || inner.name.text !== "ok") return false;
  return isCommit(inner.expression) || (id !== undefined && ts.isIdentifier(inner.expression) && inner.expression.text === id);
}
const exits = (s: ts.Statement): boolean =>
  ts.isThrowStatement(s) || ts.isReturnStatement(s) || (ts.isBlock(s) && s.statements.length === 1 && exits(s.statements[0]!));

/** The statement before the call's own statement is the guard, and (two-statement form) the one before it the commit. */
function guarded(call: ts.CallExpression): boolean {
  let stmt: ts.Node = call;
  while (stmt.parent && !ts.isBlock(stmt.parent) && !ts.isSourceFile(stmt.parent)) stmt = stmt.parent;
  const block = stmt.parent as ts.Block;
  const i = block.statements.indexOf(stmt as ts.Statement);
  const guard = block.statements[i - 1];
  if (!guard || !ts.isIfStatement(guard) || guard.elseStatement || !exits(guard.thenStatement)) return false;
  if (negatesOk(guard.expression)) return true;
  const decl = block.statements[i - 2];
  if (!decl || !ts.isVariableStatement(decl) || decl.declarationList.declarations.length !== 1) return false;
  const v = decl.declarationList.declarations[0]!;
  return ts.isIdentifier(v.name) && isCommit(v.initializer) && negatesOk(guard.expression, v.name.text);
}

function enclosing(n: ts.Node): string {
  for (let p = n.parent; p; p = p.parent) {
    if ((ts.isMethodDeclaration(p) || ts.isFunctionDeclaration(p)) && p.name) {
      const cls = nameOf(p.parent);
      return `${cls ? `${cls}.` : ""}${p.name.getText()}`;
    }
  }
  return "(top level)";
}

function scan(filter: (file: string) => boolean): Site[] {
  const sites: Site[] = [];
  for (const sf of program.getSourceFiles()) {
    if (!sf.fileName.startsWith(SRC + "/") || !filter(sf.fileName)) continue;
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        const kind = classify(n);
        if (kind) sites.push({ file: relative(SRC, sf.fileName), fn: enclosing(n), text: n.expression.getText(sf), kind, guarded: guarded(n), node: n });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return sites;
}

describe("provider-entry call-site allowlist (packet 2.4.2)", () => {
  it("finds exactly the pinned inventory in apps/api/src", () => {
    const sites = scan((f) => f !== FIXTURE);
    const inventory = sites.map((s) => `${s.kind} ${s.file} ${s.fn} ${s.text}`).sort();
    expect(inventory).toEqual([
      // The five credentialed adapter calls, at the three boundaries.
      "adapter modules/harness/session-runner.ts RunContext.startProvider adapter.resume",
      "adapter modules/harness/session-runner.ts RunContext.startProvider adapter.start",
      "adapter modules/orchestrator.ts Orchestrator.executeDispatch adapter.start",
      "adapter modules/orchestrator.ts Orchestrator.startTaskInner adapter.resume",
      "adapter modules/orchestrator.ts Orchestrator.startTaskInner adapter.start",
      // The two conformance probes on refusal or scripted adapters (not provider entries).
      ...conformance(sites),
      // Every Harness entry reaches RunContext.startProvider through the bridge and the runner.
      "bridge modules/harness/control-plane-bridge.ts HarnessBridge.start this.startRequest",
      "bridge modules/orchestrator.ts Orchestrator.executeDispatch this.harnessBridge!.startRequest",
      ...bridgeStarts(sites),
      "runner modules/harness/control-plane-bridge.ts HarnessBridge.startRequest this.runner.start",
      "runner modules/harness/session-runner.ts SessionRunner.run this.start",
      `startProvider modules/harness/session-runner.ts ${startProviderCaller(sites)} this.startProvider`,
    ].sort());
    expect(sites.filter((s) => s.kind === "adapter" && s.file === "modules/runtime-conformance.ts")).toHaveLength(2);
    expect(sites.filter((s) => s.kind === "bridge" && s.text === "this.harnessBridge!.start")).toHaveLength(2);
  }, 30_000); // the whole-tree parse took 6.2 s on a slow reviewer machine (#268 review)

  it("puts the guarded commit immediately before each of the five credentialed calls", () => {
    const credentialed = scan((f) => f !== FIXTURE).filter((s) => s.kind === "adapter" && s.file !== "modules/runtime-conformance.ts");
    expect(credentialed).toHaveLength(5);
    expect(credentialed.filter((s) => !s.guarded).map((s) => `${s.file} ${s.fn} ${s.text}`)).toEqual([]);
  });

  it("counts a renamed receiver, bracket, destructured and aliased calls, ignores a comment, and refuses an unguarded or ignored commit", () => {
    const fixture = scan((f) => f === FIXTURE);
    expect(readFileSync(join(SRC, "modules/orchestrator.ts"), "utf8")).toContain("adapter.start"); // the real file is scanned, the fixture is virtual
    expect(fixture.map((s) => [s.fn, s.text, s.guarded])).toEqual([
      ["renamed", "a.start", false],
      ["unguarded", "adapter.start", false],
      ["ignored", "adapter.start", false],
      ["guarded", "adapter.start", true],
      ["inline", "adapter.resume", true],
      ["destructured", "start", false],
      ["bracket", 'adapter["start"]', false],
      ["aliased", "s", false],
      ["guardedBracket", 'adapter["start"]', true],
    ]);
  });
});

/* The conformance probes, the composed-candidate bridge start and the startProvider caller are
 * pinned by count and file above; their enclosing names are read here so a rename there does not
 * break this test, while a new call anywhere else still does. */
function conformance(sites: Site[]): string[] {
  return sites.filter((s) => s.kind === "adapter" && s.file === "modules/runtime-conformance.ts").map((s) => `adapter ${s.file} ${s.fn} ${s.text}`);
}
function bridgeStarts(sites: Site[]): string[] {
  return sites.filter((s) => s.kind === "bridge" && s.text === "this.harnessBridge!.start" && s.file === "modules/orchestrator.ts").map((s) => `bridge ${s.file} ${s.fn} ${s.text}`);
}
function startProviderCaller(sites: Site[]): string {
  const callers = sites.filter((s) => s.kind === "startProvider");
  return callers.length === 1 ? callers[0]!.fn : `(${callers.length} callers)`;
}
