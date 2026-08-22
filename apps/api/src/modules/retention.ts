import { gzipSync, gunzipSync } from "node:zlib";
import type { Db } from "../db/index.js";
export class EventRetention {
  constructor(private db: Db, private days = 30) {}
  archive(now = new Date()): { tasks: number; events: number } {
    const cutoff = new Date(now.getTime() - this.days * 86_400_000).toISOString();
    const tasks = this.db.prepare("SELECT id FROM tasks WHERE state IN ('COMPLETED','FAILED','CANCELLED') AND updated_at < ? AND EXISTS (SELECT 1 FROM runs r JOIN events e ON e.run_id=r.id WHERE r.task_id=tasks.id) AND id NOT IN (SELECT task_id FROM event_archives)").all(cutoff) as { id: string }[];
    let count = 0;
    const archiveOne = this.db.transaction((taskId: string) => {
      const events = this.db.prepare("SELECT e.*, r.assistant_id FROM events e JOIN runs r ON r.id=e.run_id WHERE r.task_id=? ORDER BY e.ts,e.seq").all(taskId) as Record<string, unknown>[];
      if (!events.length) return;
      this.db.prepare("INSERT INTO event_archives (task_id,event_count,first_event_at,last_event_at,data,archived_at) VALUES (?,?,?,?,?,?)").run(taskId, events.length, events[0]!.ts, events.at(-1)!.ts, gzipSync(JSON.stringify(events)), now.toISOString());
      this.db.prepare("DELETE FROM events WHERE run_id IN (SELECT id FROM runs WHERE task_id=?)").run(taskId);
      count += events.length;
    });
    for (const task of tasks) archiveOne(task.id);
    return { tasks: tasks.length, events: count };
  }
  events(taskId: string): Record<string, unknown>[] {
    const row = this.db.prepare("SELECT data FROM event_archives WHERE task_id=?").get(taskId) as { data: Buffer } | undefined;
    if (!row) return [];
    const events = JSON.parse(gunzipSync(row.data).toString("utf8")) as Array<Record<string, unknown> & { payload?: string | null }>;
    return events.map((event) => ({ ...event, payload: event.payload ? JSON.parse(event.payload) as unknown : null }));
  }
}
