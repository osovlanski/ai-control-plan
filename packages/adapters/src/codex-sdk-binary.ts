import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { NotSupportedError } from "@agent-plane/core";

/** Use the SDK's pinned CLI, not an unrelated PATH installation. */
export function codexSdkBinary(): string {
  const sdk = createRequire(import.meta.resolve("@openai/codex-sdk"));
  const cli = createRequire(sdk.resolve("@openai/codex/package.json"));
  const arch = process.arch;
  const os = process.platform;
  const triples: Record<string, string> = {
    "linux-arm64": "aarch64-unknown-linux-musl", "linux-x64": "x86_64-unknown-linux-musl",
    "darwin-arm64": "aarch64-apple-darwin", "darwin-x64": "x86_64-apple-darwin",
    "win32-arm64": "aarch64-pc-windows-msvc", "win32-x64": "x86_64-pc-windows-msvc",
  };
  const triple = triples[`${os}-${arch}`];
  if (!triple) throw new NotSupportedError("Codex app-server platform");
  return join(dirname(cli.resolve(`@openai/codex-${os}-${arch}/package.json`)), `vendor/${triple}/bin/codex${os === "win32" ? ".exe" : ""}`);
}
