/**
 * P0-A2: set the hash of the `autopilot.operate` secret (docs/agentic-os-auto-copilot-plan.md §C.0).
 *
 *   pnpm --filter @agent-plane/api rotate-operate -- --hash sha256:<hex>
 *       Store a hash made elsewhere, so the secret never touches this machine. Make one with:
 *       printf %s "$SECRET" | sha256sum
 *   pnpm --filter @agent-plane/api rotate-operate
 *       Generate a secret here, print it ONCE and store only its hash. Run it yourself in your
 *       own terminal, never from an agent session: whoever reads the output can start the autopilot.
 *
 * The previous secret stops working at once.
 */
import { loadConfig } from "../config.js";
import { generateOperateSecret, operateSecretPath, writeOperateSecretHash } from "../auth/operate-secret.js";

const config = loadConfig();
const path = operateSecretPath(config.dir);
const at = process.argv.indexOf("--hash");
if (at >= 0) {
  const stored = writeOperateSecretHash(path, process.argv[at + 1] ?? "");
  process.stdout.write(`Stored operator secret hash ${stored.kid} in ${path}\n`);
} else {
  const { secret, hash } = generateOperateSecret();
  const stored = writeOperateSecretHash(path, hash);
  process.stdout.write(`Stored operator secret hash ${stored.kid} in ${path}\n`);
  process.stdout.write(`Operator secret (shown once, keep it off this machine):\n${secret}\n`);
}
