import { useState } from "react";

export const DIAGNOSTICS_KEY = "agentic-os.overview-diagnostics";

/** Per-browser preference only. Storage can be absent or throw (private mode, blocked site data). */
export function readDiagnostics(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): boolean {
  try {
    return storage?.getItem(DIAGNOSTICS_KEY) === "open";
  } catch {
    return false;
  }
}

export function writeDiagnostics(open: boolean, storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage) {
  try {
    storage?.setItem(DIAGNOSTICS_KEY, open ? "open" : "closed");
  } catch {
    /* the disclosure still works for this page */
  }
}

/** The Overview is calm by default; diagnostics stay one click away. */
export function useDiagnostics() {
  const [open, setOpen] = useState(readDiagnostics);
  return [open, (next: boolean) => { writeDiagnostics(next); setOpen(next); }] as const;
}
