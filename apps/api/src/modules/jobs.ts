import type { Registry } from "./registry.js";
import type { EventRetention } from "./retention.js";
export function msUntilDailyHour(hour: number, now = new Date()): number {
  const next = new Date(now); next.setHours(hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}
export interface JobLogger {
  error(detail: Record<string, unknown>, message: string): void;
}

/**
 * Daily capability sync + event retention.
 *
 * Every failure is contained and the next run is always rescheduled: an
 * unguarded throw in a timer callback takes down the whole API process, and
 * skipping the reschedule would silently stop the daily job forever.
 */
export function scheduleDailyJobs(
  hour: number,
  registry: Registry,
  retention: EventRetention,
  logger?: JobLogger,
): () => void {
  let timer: ReturnType<typeof setTimeout>;
  let stopped = false;

  const runOnce = async () => {
    try {
      const { failed } = await registry.syncChangedAll();
      for (const failure of failed) {
        logger?.error({ assistantId: failure.id, err: failure.error }, "daily capability sync failed");
      }
    } catch (err) {
      logger?.error({ err: String(err) }, "daily capability sync failed");
    }
    try {
      retention.archive();
    } catch (err) {
      logger?.error({ err: String(err) }, "daily event retention failed");
    }
  };

  const schedule = () => {
    timer = setTimeout(() => {
      void runOnce().finally(() => {
        if (!stopped) schedule();
      });
    }, msUntilDailyHour(hour));
    timer.unref();
  };
  schedule();
  return () => { stopped = true; clearTimeout(timer); };
}
