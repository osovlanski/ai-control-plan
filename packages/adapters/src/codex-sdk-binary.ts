import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { NotSupportedError } from "@agent-plane/core";

/** Use the SDK's pinned CLI, not an unrelated PATH installation. */
export function codexSdkBinary(): string {
  const sdk = createRequire(import.meta.resolve("@openai/codex-sdk"));
  const cli = createRequire(sdk.resolve("@openai/codex/package.json"));
  const arch = process.arch;
  const os = process.platform === "android" ? "linux" : process.platform;
  const triples: Record<string, string> = {
    "linux-arm64": "aarch64-unknown-linux-musl", "linux-x64": "x86_64-unknown-linux-musl",
    "darwin-arm64": "aarch64-apple-darwin", "darwin-x64": "x86_64-apple-darwin",
    "win32-arm64": "aarch64-pc-windows-msvc", "win32-x64": "x86_64-pc-windows-msvc",
  };
  const triple = triples[`${os}-${arch}`];
  if (!triple) throw new NotSupportedError("Codex app-server platform");
  const root = join(dirname(cli.resolve(`@openai/codex-${os}-${arch}/package.json`)), "vendor", triple);
  const name = os === "win32" ? "codex.exe" : "codex";
  // The SDK selects the packaged layout only with its metadata file, then tries its legacy layout.
  const binary = join(root, "bin", name);
  if (isFile(binary) && isFile(join(root, "codex-package.json"))) return binary;
  const legacy = join(root, "codex", name);
  if (isFile(legacy)) return legacy;
  throw new NotSupportedError("Codex SDK executable");
}

function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
}
