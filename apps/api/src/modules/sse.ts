import type { NormalizedEvent } from "@agent-plane/core";

export interface TaskStreamPayload {
  kind: "event" | "state" | "notice";
  event?: NormalizedEvent & { seq: number };
  state?: { state: string; phase?: string; assistantId?: string };
  /**
   * Control-plane announcement (handoff, failover, checkpoint) — deliberately
   * not a NormalizedEvent, which is reserved for provider activity. Automatic
   * failover must always be loud (review §3.9.6).
   */
  notice?: { level: "info" | "warn"; text: string };
}

type Subscriber = (payload: TaskStreamPayload) => void;

/** In-process fan-out of live task activity to SSE subscribers. */
export class TaskEventBus {
  private subscribers = new Map<string, Set<Subscriber>>();

  subscribe(taskId: string, fn: Subscriber): () => void {
    let set = this.subscribers.get(taskId);
    if (!set) {
      set = new Set();
      this.subscribers.set(taskId, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.subscribers.delete(taskId);
    };
  }

  publish(taskId: string, payload: TaskStreamPayload): void {
    const set = this.subscribers.get(taskId);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(payload);
      } catch {
        // A broken subscriber must not break the run loop.
      }
    }
  }
}
