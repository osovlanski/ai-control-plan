import type { NormalizedEvent, SchedulerEvent, WaitCondition } from "@agent-plane/core";

export interface TaskStreamPayload {
  kind: "event" | "state" | "notice" | "scheduler";
  scheduler?: SchedulerEvent;
  event?: NormalizedEvent & { seq: number };
  state?: { state: string; phase?: string; assistantId?: string; wait?: WaitCondition; schedulerEnabled?: boolean };
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
  private watchers = new Set<(taskId: string, payload: TaskStreamPayload) => void>();

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

  /**
   * Every frame for every task, for in-process kernel consumers rather than an
   * SSE client. Used by session-input redelivery, which needs the task-state
   * announcements the plane already makes but cannot know which task ids to
   * subscribe to in advance.
   */
  subscribeAll(fn: (taskId: string, payload: TaskStreamPayload) => void): () => void {
    this.watchers.add(fn);
    return () => {
      this.watchers.delete(fn);
    };
  }

  publish(taskId: string, payload: TaskStreamPayload): void {
    for (const fn of this.watchers) {
      try {
        fn(taskId, payload);
      } catch {
        // A broken watcher must not break the run loop either.
      }
    }
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
