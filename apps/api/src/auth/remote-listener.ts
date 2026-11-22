import { createServer, type Server } from "node:http";
import type { FastifyInstance } from "fastify";
import type { RemoteAuth } from "./remote.js";

/**
 * B2 (D-B): the second loopback listener, the Tailscale Serve target. It shares the one Fastify
 * instance (same routes, kernel and SQLite writer) and differs only in what the auth hook admits:
 * every request it receives is marked remote before routing, so `RemoteAuth.onRequest` gates it and
 * the local paths (bootstrap, bearer, local cookie) can never answer it. The mark is a WeakSet entry
 * set here and nowhere else, so no header or client value can make a local request look remote or
 * the other way round.
 */
export async function startRemoteListener(app: FastifyInstance, remote: RemoteAuth): Promise<Server> {
  await app.ready();
  const { host, port } = remote.config.listen;
  const server = createServer((req, res) => {
    remote.markRemote(req);
    app.routing(req, res);
  });
  // Slow-client bounds; the proxy keeps its own connections alive.
  server.headersTimeout = 20_000;
  server.requestTimeout = 0; // SSE streams are long-lived; RemoteAuth closes them at session end.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port }, () => { server.off("error", reject); resolve(); });
  });
  // Closed by the onClose hook `RemoteAuth.registerRoutes` added before the app was ready.
  remote.attachListener(server);
  void remote.warmUp();
  app.log.info({ event: "remote.listen", host, port }, "remote listener ready");
  return server;
}
