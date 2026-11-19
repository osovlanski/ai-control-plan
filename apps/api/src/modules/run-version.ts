import { execFile } from "node:child_process";

export type VersionOutcome =
  | { kind: "ok"; version: string }
  | { kind: "missing" | "not-runnable" | "timeout" | "nonzero" | "empty" };

/** `<command> --version`, bounded. Only the fixed version argument is passed. */
export function runVersion(command: string, timeoutMs: number): Promise<VersionOutcome> {
  return new Promise((resolve) => {
    execFile(command, ["--version"], { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024, env: process.env }, (err, stdout) => {
      if (!err) {
        const version = stdout.trim();
        return resolve(version ? { kind: "ok", version } : { kind: "empty" });
      }
      const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
      if (e.code === "ENOENT") return resolve({ kind: "missing" });
      if (e.code === "EACCES" || e.code === "ENOEXEC") return resolve({ kind: "not-runnable" });
      if (e.killed || e.signal === "SIGKILL") return resolve({ kind: "timeout" });
      return resolve({ kind: "nonzero" });
    });
  });
}
