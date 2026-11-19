/**
 * `aos runtimes` (Agent Runtime Registry PR 6, design §C PR 6 and §E).
 *
 * Every command is one or more agent-runtime v1 routes, the same ones the web Agents app calls
 * (`apps/web/src/api.ts`); `test/parity.test.ts` fails if the two drift. Bodies are validated with
 * the plane's reference validator before anything is printed, and readiness, its reasons and
 * conformance state are printed as served: nothing here recomputes them. No command writes
 * config, installs a CLI or signs in; configuring a runtime stays a local edit of the workspace
 * config file, for which `catalog <provider> --snippet` prints the same text the web UI copies.
 */
import { parseArgs } from "node:util";
import { redactSecrets } from "@agent-plane/core";
import {
  validateAssistantLifecycle, validateConformanceResult, validateOperatorStateChange, validateRuntimeCatalog, type OperatorStateChange,
} from "../../api/src/agent-runtime-contract.js";
import type { ContractResult } from "../../api/src/registry-contract.js";
import type { AssistantLifecycle, RuntimeCatalogEntry, RuntimeCatalogProjection } from "../../api/src/modules/runtime-lifecycle.js";
import type { ConformanceResult } from "../../api/src/modules/runtime-conformance.js";
// The web Agents app's text helpers: pure functions with no runtime imports, shared so the CLI and
// the UI word every state, and the config snippet, identically.
import { authText, configSnippet, conformanceText, enablementText, installedText } from "../../web/src/shell/runtime-registry.js";
import { PlaneError, type Method, type PlaneClient } from "./client.js";

export interface AssistantView { id: string; provider: string; enabled: boolean; manifest?: { core?: { auth?: { state?: string } } } | null; lifecycle?: unknown }
interface Cooldown { assistantId: string; reason: string; until: string }
interface CapabilityChange { assistant_id: string; field: string; old_value: string; new_value: string; source: string; observed_at: string }

export interface RuntimesDeps {
  /** A client whose credential holds `capability`; resolved lazily so `--help` reads no file. */
  connect(capability: "tasks.read" | "commands.write", options: { api?: string; credential?: string }): PlaneClient;
  out(text: string): void;
  err(text: string): void;
  now?: () => Date;
}

export const USAGE = `usage: aos runtimes <command> [options]

Read (tasks.read):
  ls                           configured assistants and their lifecycle
  show <id>                    one assistant: states, readiness reasons, cooldown, install/sign-in links
  catalog [<provider>]         runtimes this build supports
  catalog <provider> --snippet the workspace-config entry to paste (aos writes no config)
  changes                      recent capability changes

Write (commands.write):
  sync <id>                    capability sync (POST /api/assistants/:id/sync)
  test <id>                    credential-free conformance probe; exits 1 unless it passes
  disable <id>                 operator overlay: removes it from future routing, stops nothing
  enable <id>                  clears the operator overlay only; config can still disable it

Options:
  --json                       print the plane's validated response body instead of text
  --api <origin>               plane origin on loopback (default: workspace config, or AOS_API_URL)
  --credential <path>          bearer credential file (default: the workspace's, or AOS_CREDENTIAL_FILE)

The plane never installs a runtime or signs in; aos prints the official links and leaves that to you.`;

const enc = encodeURIComponent;

/** The route each command reaches, for `--help` and the parity test. */
export const COMMAND_ROUTES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ls: ["GET /api/assistants"],
  show: ["GET /api/assistants", "GET /api/runtimes/catalog", "GET /api/cooldowns"],
  catalog: ["GET /api/runtimes/catalog"],
  "catalog --snippet": ["GET /api/runtimes/catalog", "GET /api/assistants"],
  changes: ["GET /api/assistants/changes"],
  sync: ["POST /api/assistants/:id/sync"],
  test: ["POST /api/assistants/:id/test"],
  disable: ["POST /api/assistants/:id/disable"],
  enable: ["POST /api/assistants/:id/enable"],
});

function valid<T>(what: string, result: ContractResult<T>): T {
  if (result.ok) return result.value;
  throw new PlaneError(`The plane's ${what} does not match agent-runtime v1, so nothing is shown: ${result.errors.join("; ")}`);
}

function lifecycleOf(a: AssistantView): AssistantLifecycle {
  if (a.lifecycle === undefined) throw new PlaneError(`The plane serves no lifecycle for ${a.id}: it predates agent-runtime v1 (API 2.10)`);
  return valid(`lifecycle of ${a.id}`, validateAssistantLifecycle(a.lifecycle));
}

async function assistants(client: PlaneClient): Promise<AssistantView[]> {
  const body = await client.request<unknown>("GET", "/api/assistants");
  if (!Array.isArray(body)) throw new PlaneError("GET /api/assistants did not answer with a list");
  return body as AssistantView[];
}

async function catalog(client: PlaneClient): Promise<RuntimeCatalogProjection> {
  return valid("runtime catalogue", validateRuntimeCatalog(await client.request<unknown>("GET", "/api/runtimes/catalog")));
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join("  ").trimEnd()).join("\n");
}

const json = (value: unknown) => JSON.stringify(value, null, 2);
const readyText = (l: AssistantLifecycle) => (l.readiness.ready ? "yes" : `no (${l.readiness.reasons.length})`);

function docsLines(entry: RuntimeCatalogEntry | undefined): string[] {
  if (!entry) return ["  This build has no catalogue entry for this provider."];
  const lines: string[] = [];
  if (entry.docs?.install) lines.push(`  Install: ${entry.docs.install}`);
  if (entry.docs?.auth) lines.push(`  Sign in: ${entry.docs.auth}`);
  if (lines.length === 0) lines.push("  This build lists no official install or sign-in link for it.");
  lines.push("  The plane never installs a CLI or signs in. On a host with an agent user, run the provider CLI as that user.");
  return lines;
}

function catalogEntryText(r: RuntimeCatalogEntry): string {
  return [
    `${r.provider} · ${r.label}`,
    `  transport ${r.transport} · maturity ${r.maturity} · harness ${r.harness ?? "none (route-only, never composed)"}`,
    `  registry assistant: ${r.registryAssistant ?? "none"}`,
    `  approval modes enforced: ${r.approvalModes.join(", ") || "none"}`,
    `  conformance ${r.conformanceRequired ? "required before routing" : "not required for routing"}`,
    ...docsLines(r),
  ].join("\n");
}

function lifecycleText(id: string, provider: string, label: string | undefined, l: AssistantLifecycle): string[] {
  return [
    `${id} (${provider}${label ? ` · ${label}` : ""})`,
    `  Ready: ${l.readiness.ready ? "yes" : "no"}`,
    ...l.readiness.reasons.map((r) => `    - ${r}`),
    `  Installed: ${installedText(l.installed)}`,
    `  Auth: ${authText(l.auth)}`,
    `  Conformance: ${conformanceText(l.conformance)}`,
    `  Enablement: ${enablementText(l.enablement)}`,
    `  Ready covers only checks that do not depend on a task. The router still decides each task against ${l.requestDependent.join(", ")}.`,
  ];
}

function changedNotice(r: OperatorStateChange): string {
  if (r.operatorState === "disabled") {
    return r.changed ? `${r.assistantId} is disabled for future routing. Sessions already running are not stopped.` : `${r.assistantId} was already disabled by operator.`;
  }
  const configNote = r.lifecycle.enablement.config ? "" : " Workspace config still disables it.";
  return `${r.assistantId}: ${r.changed ? "operator override cleared." : "had no operator override."}${configNote}`;
}

/** Runs `aos runtimes <argv…>`. Returns the exit code: 0 ok, 1 failure, 2 usage. */
export async function runRuntimes(argv: string[], deps: RuntimesDeps): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try { parsed = parse(argv); } catch (e) { deps.err(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`); return 2; }
  const { values, positionals } = parsed;
  const [command, arg, ...extra] = positionals;
  if (values.help || command === "help") { deps.out(USAGE); return 0; }
  if (command === undefined) { deps.err(USAGE); return 2; }
  const needsId = ["show", "sync", "test", "disable", "enable"].includes(command);
  const known = needsId || ["ls", "catalog", "changes"].includes(command);
  const usage = (text: string) => { deps.err(`${text}\n\n${USAGE}`); return 2; };
  if (!known) return usage(`Unknown command: ${command}`);
  if (needsId && !arg) return usage(`aos runtimes ${command} needs an assistant id`);
  if (!needsId && command !== "catalog" && arg) return usage(`aos runtimes ${command} takes no argument`);
  if (extra.length) return usage(`Unexpected argument: ${extra[0]}`);
  if (values.snippet && (command !== "catalog" || !arg)) return usage("--snippet goes with: aos runtimes catalog <provider> --snippet");
  const print = (text: string) => deps.out(redactSecrets(text));

  try {
    const write = ["sync", "test", "disable", "enable"].includes(command);
    const client = deps.connect(write ? "commands.write" : "tasks.read", { api: values.api, credential: values.credential });
    const post = <T>(action: string) => client.request<T>("POST" as Method, `/api/assistants/${enc(arg!)}/${action}`);

    switch (command) {
      case "ls": {
        const list = await assistants(client);
        const lifecycles = list.map(lifecycleOf);
        if (values.json) { print(json(list)); return 0; }
        if (list.length === 0) { print("No assistant environments configured."); return 0; }
        print(table([
          ["ID", "PROVIDER", "READY", "INSTALLED", "AUTH", "CONFORMANCE", "OPERATOR"],
          ...list.map((a, i) => {
            const l = lifecycles[i]!;
            return [a.id, a.provider, readyText(l), installedText(l.installed), l.auth.state, l.conformance.state, l.enablement.operator];
          }),
        ]));
        return 0;
      }
      case "show": {
        const list = await assistants(client);
        const a = list.find((x) => x.id === arg);
        if (!a) throw new PlaneError(`Unknown assistant: ${arg}`, 404);
        const l = lifecycleOf(a);
        if (values.json) { print(json(l)); return 0; }
        const [cat, cooldowns] = await Promise.all([catalog(client), client.request<Cooldown[]>("GET", "/api/cooldowns")]);
        const entry = cat.runtimes.find((r) => r.provider === a.provider);
        const now = (deps.now ?? (() => new Date()))().getTime();
        const cooldown = cooldowns.find((c) => c.assistantId === a.id && Date.parse(c.until) > now);
        print([
          ...lifecycleText(a.id, a.provider, entry?.label, l),
          `  Cooldown: ${cooldown ? `until ${cooldown.until} (${cooldown.reason})` : "none active"}`,
          "Install and sign in:",
          ...docsLines(entry),
        ].join("\n"));
        return 0;
      }
      case "catalog": {
        const cat = await catalog(client);
        if (!arg) {
          if (values.json) { print(json(cat)); return 0; }
          print(table([
            ["PROVIDER", "LABEL", "TRANSPORT", "MATURITY", "HARNESS", "CONFORMANCE"],
            ...cat.runtimes.map((r) => [r.provider, r.label, r.transport, r.maturity, r.harness ?? "-", r.conformanceRequired ? "required" : "not required"]),
          ]));
          print(`\ndescriptor v${cat.descriptorVersion} · agent-runtime ${cat.schemaVersion} · being listed grants nothing`);
          return 0;
        }
        const entry = cat.runtimes.find((r) => r.provider === arg);
        if (!entry) throw new PlaneError(`${arg} is not in this build's runtime catalogue (${cat.runtimes.map((r) => r.provider).join(", ")})`);
        if (values.snippet) {
          const taken = (await assistants(client)).map((a) => a.id);
          print(configSnippet(entry.provider, taken));
          return 0;
        }
        print(values.json ? json(entry) : catalogEntryText(entry));
        return 0;
      }
      case "changes": {
        const changes = await client.request<CapabilityChange[]>("GET", "/api/assistants/changes");
        if (values.json) { print(json(changes)); return 0; }
        if (changes.length === 0) { print("No capability changes recorded."); return 0; }
        print(table([
          ["OBSERVED", "ASSISTANT", "FIELD", "CHANGE"],
          ...changes.map((c) => [c.observed_at, c.assistant_id, c.field, `${c.old_value || "(none)"} -> ${c.new_value || "(none)"}`]),
        ]));
        return 0;
      }
      case "sync": {
        const manifest = await post<{ core?: { auth?: { state?: string } } }>("sync");
        if (values.json) { print(json(manifest)); return 0; }
        print(`${arg}: capability sync done · manifest auth ${manifest.core?.auth?.state ?? "unknown"}. Lifecycle: aos runtimes show ${arg}`);
        return 0;
      }
      case "test": {
        const result: ConformanceResult = valid("conformance result", validateConformanceResult(await post<unknown>("test")));
        if (values.json) print(json(result));
        else {
          print([
            `${result.assistantId}: test ${result.status}${result.recorded ? " (recorded)" : " (not recorded)"} · ${result.cliVersion ? `CLI ${result.cliVersion}` : "no CLI version"} · descriptor v${result.descriptorVersion}`,
            table(result.checks.map((c) => [`  ${c.status}`, c.name, c.level, c.reason])),
            ...(result.reasons.length ? [`  reasons: ${result.reasons.join(", ")}`] : []),
            `  Conformance now: ${conformanceText(result.lifecycle.conformance)}`,
          ].join("\n"));
        }
        return result.status === "pass" ? 0 : 1;
      }
      case "disable":
      case "enable": {
        const change = valid(`${command} answer`, validateOperatorStateChange(await post<unknown>(command)));
        print(values.json ? json(change) : changedNotice(change));
        return 0;
      }
    }
    return 2;
  } catch (e) {
    deps.err(redactSecrets(`aos runtimes ${command}: ${e instanceof Error ? e.message : String(e)}`));
    return 1;
  }
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      json: { type: "boolean" },
      snippet: { type: "boolean" },
      api: { type: "string" },
      credential: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
}
