/** Legacy spike aliases now exercise the shipping transport. */
export { CodexAppServerProtocol as SpikeProtocol, type RpcFrame } from "../../src/codex-app-server-protocol.js";
import type { RpcFrame } from "../../src/codex-app-server-protocol.js";
export function steerAckCeiling(frame: RpcFrame): "transport" | undefined {
  return !frame.error && typeof frame.result?.turnId === "string" ? "transport" : undefined;
}
