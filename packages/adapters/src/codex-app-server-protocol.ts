import type { Readable, Writable } from "node:stream";
import { SessionInputUnresolvedError } from "@agent-plane/core";

export interface RpcFrame {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** JSONL request transport. No retry, reconnect or inferred delivery receipts. */
export class CodexAppServerProtocol {
  private nextId = 1;
  private buffer = "";
  private closed = false;
  private pending = new Map<number, { resolve: (frame: RpcFrame) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    private input: Writable,
    output: Readable,
    private observe: (frame: RpcFrame) => void = () => {},
    private timeoutMs = 5_000,
    private onDisconnect: () => void = () => {},
  ) {
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      if (this.closed) return;
      this.buffer += chunk;
      if (this.buffer.length > 4_194_304) { this.disconnect(); return; }
      let end: number;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        let frame: RpcFrame;
        try { frame = JSON.parse(line) as RpcFrame; } catch { this.disconnect(); return; }
        if (!frame || typeof frame !== "object" || Array.isArray(frame)) { this.disconnect(); return; }
        try { this.observe(frame); } catch { this.disconnect(); return; }
        if (this.closed) return;
        if (typeof frame.id === "number" && !frame.method) {
          const pending = this.pending.get(frame.id);
          if (pending) { clearTimeout(pending.timer); this.pending.delete(frame.id); pending.resolve(frame); }
        }
        // Unknown tool/approval requests fail closed, without granting execution.
        if (frame.method && frame.id !== undefined) {
          this.write({ id: frame.id, error: { code: -32601, message: "Unsupported by control plane" } });
        }
      }
    });
    output.on("end", () => this.disconnect());
    output.on("error", () => this.disconnect());
    input.on("error", () => this.disconnect());
  }

  async initialize(): Promise<RpcFrame> {
    const response = await this.request("initialize", { clientInfo: { name: "agent_plane", version: "0.1.0" } });
    if (response.error) throw new Error(`initialize: ${response.error.code}`);
    this.write({ method: "initialized", params: {} });
    return response;
  }

  request(method: string, params: Record<string, unknown>): Promise<RpcFrame> {
    if (this.closed) return Promise.reject(new SessionInputUnresolvedError("app_server_disconnected"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SessionInputUnresolvedError("app_server_response_timeout"));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.input.write(JSON.stringify({ id, method, params }) + "\n", (error) => { if (error) this.disconnect(); });
      } catch { this.disconnect(); }
    });
  }

  private write(frame: RpcFrame): void {
    if (this.closed) return;
    try { this.input.write(JSON.stringify(frame) + "\n", error => { if (error) this.disconnect(); }); }
    catch { this.disconnect(); }
  }

  get connected(): boolean { return !this.closed; }

  disconnect(): void {
    if (this.closed) return;
    this.closed = true;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new SessionInputUnresolvedError("app_server_disconnected"));
    }
    this.pending.clear();
    this.onDisconnect();
  }
}
