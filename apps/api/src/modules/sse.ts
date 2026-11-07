import type { NormalizedEvent, SchedulerEvent, TaskStage, WaitCondition } from "@agent-plane/core";

export interface TaskStreamPayload {
  kind: "event" | "state" | "notice" | "scheduler";
  scheduler?: SchedulerEvent;
  event?: NormalizedEvent & { seq: number };
  /**
   * `stage` (API 2.9, task-stage v1) is added by the bus to every state frame it publishes, from
   * the source the composition root installs, so no publisher can forget it or compute it
   * differently.
   */
  state?: { state: string; phase?: string; assistantId?: string; wait?: WaitCondition; schedulerEnabled?: boolean; stage?: TaskStage };
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
  private stageOf?: (taskId: string) => TaskStage | undefined;
  /** The stage on the last state frame published per task, for {@link publishIfStageChanged}. */
  private lastStage = new Map<string, string>();

  /** Installs the one stage source every state frame is stamped from (task-stage v1). */
  setStageSource(fn: (taskId: string) => TaskStage | undefined): void {
    this.stageOf = fn;
  }

  /**
   * Publishes the frame `build` returns only when the task's stage moved since the last state
   * frame. For changes no publisher announces as a task-state change: a session entering or
   * leaving AWAITING_APPROVAL or VERIFYING inside a RUNNING task.
   */
  publishIfStageChanged(taskId: string, build: () => NonNullable<TaskStreamPayload["state"]> | undefined): void {
    const stage = this.safeStage(taskId);
    if (!stage || this.lastStage.get(taskId) === key(stage)) return;
    const state = build();
    if (state) this.publish(taskId, { kind: "state", state: { ...state, stage } });
  }

  private safeStage(taskId: string): TaskStage | undefined {
    try {
      return this.stageOf?.(taskId);
    } catch {
      return undefined; // a stage read must never break the run loop that published
    }
  }

  private stamp(taskId: string, payload: TaskStreamPayload): TaskStreamPayload {
    if (payload.kind !== "state" || !payload.state) return payload;
    const stage = payload.state.stage ?? this.safeStage(taskId);
    if (!stage) return payload;
    this.lastStage.set(taskId, key(stage)); // one short string per task seen by this process
    return payload.state.stage ? payload : { ...payload, state: { ...payload.state, stage } };
  }

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

  publish(taskId: string, raw: TaskStreamPayload): void {
    const payload = this.stamp(taskId, raw);
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

const key = (stage: TaskStage): string => `${stage.value}/${stage.rule}`;
