import { findCodexPath } from "@openai/codex-sdk";

/** The pnpm patch exports the pinned SDK constructor's own resolver, including its legacy fallback. */
export function codexSdkBinary(): string {
  return findCodexPath().executablePath;
}
