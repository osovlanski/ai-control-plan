/**
 * mcp-api-grants (API 2.14): idempotent task create and start (docs/adr/mcp-connector.md).
 *
 * The record is keyed by (credential kid, operation, key) and carries a request fingerprint. The
 * caller writes it with `record()` INSIDE the transaction that makes the effect, then `complete()`s
 * it with the answer. A request whose key is already being handled by this process is refused as
 * in progress (one plane process owns the DB, so an in-memory set is enough).
 */
import { createHash } from "node:crypto";
import { jcs } from "@agent-plane/core";
import type { Db } from "../db/index.js";

export type IdempotentOperation = "task.create" | "task.start";
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,128}$/;
export const IDEMPOTENCY_RETENTION_MS = 7 * 24 * 3_600_000;

export interface IdempotencyRecord {
  fingerprint: string;
  taskId: string;
  statusCode: number | null;
  response: Record<string, unknown> | null;
  createdAt: string;
}

export type Lookup =
  | { kind: "new" }
  | { kind: "replay"; record: IdempotencyRecord }
  | { kind: "conflict" };

/** sha256 of the canonical JSON of the normalized request, without the key. */
export function fingerprint(value: unknown): string {
  return `sha256:${createHash("sha256").update(jcs(value), "utf8").digest("hex")}`;
}

export class IdempotencyStore {
  private readonly inFlight = new Set<string>();
  constructor(private readonly db: Db, private readonly now: () => Date) {}

  /** Claims the key for this request in this process; false = another request holds it now. */
  claim(kid: string, op: IdempotentOperation, key: string): (() => void) | undefined {
    const id = JSON.stringify([kid, op, key]);
    if (this.inFlight.has(id)) return undefined;
    this.inFlight.add(id);
    return () => { this.inFlight.delete(id); };
  }

  lookup(kid: string, op: IdempotentOperation, key: string, print: string): Lookup {
    const row = this.db.prepare(
      `SELECT fingerprint, task_id, status_code, response_json, created_at FROM idempotency_records
       WHERE credential_kid = ? AND operation = ? AND idempotency_key = ?`,
    ).get(kid, op, key) as { fingerprint: string; task_id: string; status_code: number | null; response_json: string | null; created_at: string } | undefined;
    if (!row) return { kind: "new" };
    if (row.fingerprint !== print) return { kind: "conflict" };
    return {
      kind: "replay",
      record: {
        fingerprint: row.fingerprint, taskId: row.task_id, statusCode: row.status_code,
        response: row.response_json ? (JSON.parse(row.response_json) as Record<string, unknown>) : null, createdAt: row.created_at,
      },
    };
  }

  /** Call inside the transaction that makes the effect. */
  record(kid: string, op: IdempotentOperation, key: string, print: string, taskId: string): void {
    this.db.prepare(
      `INSERT INTO idempotency_records (credential_kid, operation, idempotency_key, fingerprint, task_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(kid, op, key, print, taskId, this.now().toISOString());
  }

  complete(kid: string, op: IdempotentOperation, key: string, statusCode: number, response: Record<string, unknown>): void {
    this.db.prepare(
      `UPDATE idempotency_records SET status_code = ?, response_json = ?, completed_at = ?
       WHERE credential_kid = ? AND operation = ? AND idempotency_key = ?`,
    ).run(statusCode, JSON.stringify(response), this.now().toISOString(), kid, op, key);
  }

  /** Drops records older than the retention window. */
  sweep(): number {
    const cutoff = new Date(this.now().getTime() - IDEMPOTENCY_RETENTION_MS).toISOString();
    return this.db.prepare("DELETE FROM idempotency_records WHERE created_at < ?").run(cutoff).changes;
  }
}
