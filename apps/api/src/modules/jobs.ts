import type { Registry } from "./registry.js";
import type { EventRetention } from "./retention.js";
export function msUntilDailyHour(hour: number, now = new Date()): number {
  const next = new Date(now); next.setHours(hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}
export function scheduleDailyJobs(hour: number, registry: Registry, retention: EventRetention): () => void {
  let timer: ReturnType<typeof setTimeout>;
  let stopped = false;
  const schedule = () => {
    timer = setTimeout(() => {
      void registry.syncChangedAll();
      retention.archive();
      if (!stopped) schedule();
    }, msUntilDailyHour(hour));
    timer.unref();
  };
  schedule();
  return () => { stopped = true; clearTimeout(timer); };
}
