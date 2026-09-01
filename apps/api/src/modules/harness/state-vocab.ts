/**
 * Read-time effective run-state + usage (execution-harness.md §5, PLAN.md 8e).
 *
 * `session_state` is authoritative for harness rows (`execution_request_id` NOT
 * NULL); legacy `state`, vocab-mapped, for legacy rows. No dual-write. Harness
 * rows never populate `runs.usage`, so usage falls back to the terminal
 * `execution_results.result.usage`.
 *
 * One builder per concern so every read path (`telemetry.scores`,
 * `Orchestrator.comparison`, the `/api/tasks/:id` detail) derives state and
 * usage identically — the drift between those sites is exactly what the Codex
 * 8e review caught.
 */

/** `p` = the `runs` alias in the query ("" when unqualified, e.g. "r"). */
const q = (p: string) => (p ? `${p}.` : "");

/** SQL expression: the unified effective state. */
export function effectiveStateSql(p = ""): string {
  const c = q(p);
  return `CASE WHEN ${c}execution_request_id IS NULL
    THEN CASE ${c}state WHEN 'ACTIVE' THEN 'RUNNING' WHEN 'ENDED_OK' THEN 'COMPLETED'
                        WHEN 'ENDED_ERROR' THEN 'FAILED' ELSE ${c}state END
    ELSE ${c}session_state END`;
}

/** SQL expression: usage, falling back to the terminal `execution_results` row. */
export function effectiveUsageSql(p = "", er = "er"): string {
  return `COALESCE(${q(p)}usage, json_extract(${er}.result, '$.usage'))`;
}

/** SQL fragment: the LEFT JOIN that {@link effectiveUsageSql} needs. */
export function effectiveUsageJoin(p = "", er = "er"): string {
  return `LEFT JOIN execution_results ${er} ON ${er}.session_id = ${q(p)}id`;
}
