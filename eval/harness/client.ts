/**
 * Auth for eval scenarios (increment 3, plan §4 step 20, Codex round-1 finding #8).
 *
 * The eval runner is a server-side caller with its own workspace, so it
 * authenticates the same way any other bearer client would: read the
 * owner-only credential file, pick the newest active secret with
 * `commands.write`, send it as `Authorization: Bearer <secret>`. The secret is
 * registered in the redaction literal set immediately and is never written to
 * a scorecard, log line, or artifact.
 */
import { registerSecret } from "@agent-plane/core";
import { credentialPath, readCredential } from "../../apps/api/src/auth/credential-file.js";
import type { ResolvedConfig } from "../../apps/api/src/config.js";

export interface EvalClient {
  headers: { authorization: string };
}

export function bearerClient(config: ResolvedConfig): EvalClient {
  const file = readCredential(credentialPath(config.dir));
  const secret = file.secrets.find((s) => s.capabilities.includes("commands.write"));
  if (!secret) throw new Error(`No active credential in ${config.dir} covers commands.write`);
  registerSecret(secret.secret);
  return { headers: { authorization: `Bearer ${secret.secret}` } };
}
