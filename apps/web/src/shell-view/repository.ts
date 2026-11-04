export const REPOSITORY_KEY = "agentic-os.shell-repository";

/** Browser preference only; a remembered path still has to be in the workspace allowlist. */
export function readRepository(storage?: Pick<Storage, "getItem">): string {
  try { return (storage ?? globalThis.localStorage)?.getItem(REPOSITORY_KEY) ?? ""; }
  catch { return ""; }
}

export function writeRepository(path: string, storage?: Pick<Storage, "setItem">) {
  try { (storage ?? globalThis.localStorage)?.setItem(REPOSITORY_KEY, path); }
  catch { /* Blocked browser storage must not prevent choosing a repository. */ }
}
