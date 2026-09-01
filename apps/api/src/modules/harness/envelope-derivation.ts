import type { NormalizedEvent, TaskEnvelope } from "@agent-plane/core";

/**
 * Rolling tail of activity summaries (envelope "completed" hints), de-duplicated
 * against the whole list rather than just the last entry: after a handoff the
 * next assistant narrates the same steps again, and a package that accumulates
 * those repeats gets worse with every hop.
 */
export function mergeTail(list: string[], entry: string, max = 20): string[] {
  if (list.includes(entry)) return list;
  const next = [...list, entry];
  return next.length > max ? next.slice(next.length - max) : next;
}

/**
 * The envelope-shaping subset of the legacy `Orchestrator.applyEvent` switch:
 * `phase`, `file.changed` → `changedFiles`, `test.result` → `testResults`,
 * `message` → `completed`. Mutates `envelope` in place and returns whether
 * anything changed (the caller persists on `true`).
 *
 * Run / adapter / DB side effects (`run.started` provider-ref persist,
 * `usage.updated` runs.usage + quota snapshot + soft-threshold checkpoint,
 * `limit.approaching` / `limit.hit`) are deliberately NOT here — they stay in
 * `Orchestrator.applyEvent` for the legacy path and are handled explicitly
 * bridge-side for flag-ON single mode (PLAN.md Commit 8b).
 */
export function deriveEnvelopeUpdate(envelope: TaskEnvelope, event: NormalizedEvent): boolean {
  let changed = false;

  if (event.phase && envelope.status.phase !== event.phase) {
    envelope.status.phase = event.phase;
    changed = true;
  }

  switch (event.type) {
    case "file.changed": {
      const payload = event.payload as { path?: string; ok?: boolean } | undefined;
      const path = payload?.path;
      // Adapters (Codex) report attempted-but-failed changes with ok:false;
      // only a change that actually landed belongs in the envelope.
      if (path && payload?.ok !== false && !envelope.artifacts.changedFiles.includes(path)) {
        envelope.artifacts.changedFiles.push(path);
        changed = true;
      }
      break;
    }
    case "test.result": {
      const p = event.payload as { passed?: number; failed?: number } | undefined;
      envelope.artifacts.testResults.push({
        at: event.ts,
        passed: p?.passed ?? 0,
        failed: p?.failed ?? 0,
      });
      changed = true;
      break;
    }
    case "message": {
      const text = (event.payload as { text?: string } | undefined)?.text;
      if (text) {
        envelope.nextAction = undefined;
        envelope.completed = mergeTail(envelope.completed, event.summary);
        changed = true;
      }
      break;
    }
    default:
      break;
  }

  return changed;
}
