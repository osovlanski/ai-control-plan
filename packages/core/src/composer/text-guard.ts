/**
 * Determinism text guard (plans/m2-composer.md §4.4). Every `why`, `evidence` and filter `reason`
 * passes it before it enters a decision. It reuses bundle v1's timestamp and absolute-path shapes
 * (`CONTENT_GUARDS` in apps/api/src/bundle-contract.ts) and adds the hostnames the caller names:
 * the machine's own and the Cockpit base URL host. `CompositionStore.persist` runs its own guard
 * again; this one is what keeps an untrusted string out of the digest in the first place.
 */

import { hasLoneSurrogate } from "../canonical-json.js";

const TIMESTAMP = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const ABSOLUTE_PATH = /(^|[\s"'`(=])(\/(home|Users|root|tmp|var|private)\/|~\/|[A-Za-z]:\\)/m;

export const WITHHELD = {
  why: "why withheld: failed text guard",
  evidence: "evidence withheld: failed text guard",
  reason: "reason withheld: failed text guard",
  rendererReason: "excluded by renderer (reason withheld: failed text guard)",
} as const;

export type TextGuard = (text: string) => boolean;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when `text` may enter a decision. */
export function createTextGuard(forbiddenHostnames: readonly string[]): TextGuard {
  const hosts = [...new Set(forbiddenHostnames.map((h) => h.trim().toLowerCase()).filter((h) => h.length > 0))].sort();
  // A hostname counts only as a whole label sequence: `box` does not match `inbox`, but does match `box.local`.
  const hostPattern = hosts.length
    ? new RegExp(`(?<![A-Za-z0-9.-])(?:${hosts.map(escapeRegExp).join("|")})(?![A-Za-z0-9-])`, "i")
    : undefined;
  // An unpaired surrogate has no RFC 8785 form, so it would make the digest throw.
  return (text) => !hasLoneSurrogate(text) && !TIMESTAMP.test(text) && !ABSOLUTE_PATH.test(text) && !(hostPattern?.test(text) ?? false);
}

/** `text` when it passes, otherwise `fallback`. */
export function guarded(guard: TextGuard, text: string, fallback: string): string {
  return guard(text) ? text : fallback;
}
