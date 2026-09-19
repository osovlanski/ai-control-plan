import { useEffect, useState } from "react";
import { api, type Assistant } from "../api.js";
import { executionRead, type Mission } from "./execution.js";

type Cooldown = { assistantId: string; reason: string; until: string };

/** Board data: tasks + the provider constellation, refreshed every 4s. */
export function useBoard(revision: number, active: boolean) {
  const [tasks, setTasks] = useState<Mission[]>([]);
  const [unavailable, setUnavailable] = useState<string[]>([]);
  const [assistants, setAssistants] = useState<Assistant[]>([]);
  const [cooldowns, setCooldowns] = useState<Cooldown[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!active) {
      setLoading(true);
      setTasks([]);
      setAssistants([]);
      setCooldowns([]);
      return;
    }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      const [rows, a, c] = await Promise.allSettled([api.tasks(), api.assistants(), api.cooldowns()]);
      if (disposed) return;
      const missing = [a.status === "rejected" ? "Provider discovery" : "", c.status === "rejected" ? "Cooldowns" : ""].filter(Boolean);
      if (rows.status === "fulfilled") {
        const missions: Mission[] = [...rows.value];
        // Read only RUNNING missions, in bounded batches. This existing endpoint
        // includes effective session states and all parallel runs, not just the last.
        const active = missions.filter(t => t.state === "RUNNING");
        for (let i = 0; i < active.length && !disposed; i += 6) {
          const batch = active.slice(i, i + 6);
          const details = await Promise.allSettled(batch.map(async t => {
            const [detail, sessions] = await Promise.all([api.task(t.id), api.sessions(t.id)]);
            return executionRead(detail, sessions);
          }));
          details.forEach((result, j) => {
            if (result.status === "fulfilled") batch[j]!.execution = result.value;
            else {
              batch[j]!.execution = { awaitingApproval: false, assistants: [], verified: false };
              missing.push(`Execution / approval state for ${batch[j]!.id}`);
            }
          });
        }
        if (disposed) return;
        setTasks(missions);
        setError(null);
      } else setError((rows.reason as Error).message);
      setUnavailable(missing);
      if (a.status === "fulfilled") setAssistants(a.value);
      else setAssistants([]);
      if (c.status === "fulfilled") setCooldowns(c.value);
      else setCooldowns([]);
      setLoading(false);
      timer = setTimeout(() => void load(), 4000);
    };
    void load();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [revision, active]);
  return { tasks, assistants, cooldowns, error, loading, unavailable };
}
