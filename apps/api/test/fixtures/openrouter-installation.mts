// Run in a child so that only this test sees the temporary SDK package tree.
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { RunSpec } from "@agent-plane/core";

const home = process.argv[2]!;
const packages = join(home, "node_modules/@openai");
const sdk = join(packages, "codex-sdk");
mkdirSync(join(sdk, "dist"), { recursive: true });
const source = fileURLToPath(new URL("../../../../packages/adapters/node_modules/@openai/codex-sdk/", import.meta.url));
for (const file of ["package.json", "dist/index.js"]) copyFileSync(join(source, file), join(sdk, file));
const sdkUrl = pathToFileURL(join(sdk, "dist/index.js")).href;
// Redirect package loading only. The SDK's own package lookup, stat calls and spawn run normally.
register("data:text/javascript," + encodeURIComponent(`
  export function resolve(specifier, context, next) {
    if (specifier === "@openai/codex-sdk") return { url: ${JSON.stringify(sdkUrl)}, shortCircuit: true };
    return next(specifier, context);
  }
`));

const { loadConfig } = await import("../../src/config.js");
const { openDb } = await import("../../src/db/index.js");
const { Registry } = await import("../../src/modules/registry.js");
const { RuntimeLifecycleReader } = await import("../../src/modules/runtime-lifecycle.js");
const configFile = join(home, "personal/config.yaml");
writeFileSync(configFile, JSON.stringify({ assistants: { router: { provider: "openrouter", options: { baseUrl: "http://127.0.0.1:1" } } } }));
const config = loadConfig({ AGENT_PLANE_HOME: home });
const db = openDb(config.dbPath);
const registry = new Registry(db, config);
registry.init(); // even with the CLI package absent
await registry.syncChanged("router");
const evidence = () => db.prepare("SELECT fingerprint, details, observed_at FROM capability_probes WHERE assistant_id = 'router'").get();
const original = evidence();
assert.match((original as { details: string }).details, /"version":"in-process"/);
// A fresh reader per probe: each call must see the filesystem now, not the 60s cached result.
async function state(current = new RuntimeLifecycleReader(db, config)) {
  const row = registry.get("router")!;
  return (await current.withInstallation(current.of(row), row.provider)).installed.state;
}
const triple = (process.arch === "x64" ? "x86_64" : "aarch64") + (process.platform === "linux" ? "-unknown-linux-musl" : "-apple-darwin");
const platform = join(packages, `codex-${process.platform}-${process.arch}`);
const root = join(platform, "vendor", triple);
const preferred = join(root, "bin/codex");
const legacy = join(root, "codex/codex");
const marker = join(home, "invoked");
const metadata = join(root, "codex-package.json");
function executable(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '#!/bin/sh\nprintf "%s %s" "$0" "$1" > "$MARKER"\nif [ "$1" = exec ]; then /bin/cat >/dev/null; else echo unavailable; fi\n', { mode: 0o755 });
}
process.env.MARKER = marker;
process.env.PATH = home;
executable(join(home, "codex")); // PATH decoy
assert.equal(await state(), "missing");
for (const pkg of [join(packages, "codex"), platform]) {
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), "{}");
}
executable(preferred);
executable(legacy);
const adapter = registry.adapter("router");
async function assertParity(binary: string) {
  const run: RunSpec = { taskId: "AG-1" as RunSpec["taskId"], prompt: "fixture", workdir: home,
    permissionPolicy: { mode: "read-only" }, env: { redactionRules: [], maxRuntimeMs: 5000 } };
  const handle = await adapter.start(run);
  for await (const _ of adapter.events(handle)) { /* drain the local stand-in */ }
  assert.equal(readFileSync(marker, "utf8"), binary + " exec");
  assert.equal(await state(), "present");
  assert.equal(readFileSync(marker, "utf8"), binary + " --version");
}
writeFileSync(metadata, "{}");
chmodSync(dirname(preferred), 0);
try {
  if (process.getuid!() !== 0) {
    assert.throws(() => statSync(preferred), { code: "EACCES" });
    await assertParity(legacy);
  }
} finally {
  chmodSync(dirname(preferred), 0o755);
}
await assertParity(preferred);
chmodSync(preferred, 0o644); // The SDK selected a regular file. Spawn failure does not trigger fallback.
assert.equal(await state(), "missing");
chmodSync(preferred, 0o755);
rmSync(metadata);
await assertParity(legacy);
symlinkSync(metadata, metadata); // ELOOP while checking metadata also selects legacy, including as root.
await assertParity(legacy);
writeFileSync(legacy, "#!/bin/sh\nexit 1\n");
assert.equal(await state(), "unknown");
chmodSync(legacy, 0o644);
assert.equal(await state(), "missing");
rmSync(legacy);
assert.equal(await state(), "missing");
assert.deepEqual(evidence(), original);

writeFileSync(configFile, JSON.stringify({ assistants: {} }));
const removed = new RuntimeLifecycleReader(db, loadConfig({ AGENT_PLANE_HOME: home }));
assert.equal(await state(removed), "unknown");
db.close();
