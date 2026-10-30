import { useState } from "react";

export type OverviewView = "orbit" | "shell";
export const VIEW_KEY = "agentic-os.overview-view";

/** Per-browser preference only. Storage can be absent or throw (private mode, blocked site data). */
export function readView(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): OverviewView {
  try {
    return storage?.getItem(VIEW_KEY) === "shell" ? "shell" : "orbit";
  } catch {
    return "orbit";
  }
}

export function writeView(view: OverviewView, storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage) {
  try {
    storage?.setItem(VIEW_KEY, view);
  } catch {
    /* the toggle still works for this page */
  }
}

export function useOverviewView() {
  const [view, setView] = useState<OverviewView>(() => readView());
  return [view, (next: OverviewView) => { writeView(next); setView(next); }] as const;
}
