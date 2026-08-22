/** Branded string ids so a RunId can't silently be passed where a TaskId is expected. */

export type TaskId = string & { readonly __brand: "TaskId" };
export type RunId = string & { readonly __brand: "RunId" };
export type AssistantId = string & { readonly __brand: "AssistantId" };
export type CheckpointId = string & { readonly __brand: "CheckpointId" };
export type HandoffId = string & { readonly __brand: "HandoffId" };

/** Opaque provider-side session/thread reference (Claude session id, Codex thread id, ...). */
export type ProviderSessionRef = string & { readonly __brand: "ProviderSessionRef" };

// Node 19+ and all browsers provide crypto.randomUUID on globalThis; typed
// locally so core stays free of lib.dom / @types/node.
const uuid = (): string =>
  (globalThis as unknown as { crypto: { randomUUID(): string } }).crypto.randomUUID();

let taskCounter = 0;

/** Human-friendly task ids: AG-<epoch36><seq>. Uniqueness within one instance is sufficient. */
export function newTaskId(now: Date = new Date()): TaskId {
  taskCounter = (taskCounter + 1) % 1000;
  return `AG-${now.getTime().toString(36)}${taskCounter.toString(36)}` as TaskId;
}

export function newRunId(): RunId {
  return `run_${uuid()}` as RunId;
}

export function newCheckpointId(): CheckpointId {
  return `ckpt_${uuid()}` as CheckpointId;
}

export function newHandoffId(): HandoffId {
  return `ho_${uuid()}` as HandoffId;
}
