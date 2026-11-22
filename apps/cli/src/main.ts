#!/usr/bin/env node
/**
 * `aos`: the operator CLI over the Control Plane's own routes. Run it as `pnpm exec aos …` (the
 * package's `bin`, which prints only the command's own output, so `--json` pipes cleanly) or
 * `pnpm -s aos …` from the repository root. Groups so far: `aos status` and `aos task`
 * (p1-3 slice 1, read-only, plus tlm-03's `provenance`) and `aos runtimes` (Agent Runtime
 * Registry PR 6). The act half of `p1-3-aos-cli` (new, start, approve, stop) is slice 2.
 */
import { connect } from "./client.js";
import { runRuntimes, USAGE as RUNTIMES_USAGE } from "./runtimes.js";
import { runStatus, USAGE as STATUS_USAGE } from "./status.js";
import { runTask, USAGE as TASK_USAGE } from "./task.js";

export const USAGE = `usage: aos <group> [<command>] [options]

Groups:
  status      one read-only health readout of the plane
  task        task reads: ls, show, events [--follow], verdict, provenance, estimate
  runtimes    the runtime catalogue, lifecycle, sync, test, disable and enable

Exit codes (every command): 0 ok, 1 failure, 2 usage. Each group's help says what 1 covers.

${STATUS_USAGE}

${TASK_USAGE}

${RUNTIMES_USAGE}`;

export async function main(argv: string[]): Promise<number> {
  const [group, ...rest] = argv;
  if (group === "runtimes") {
    return runRuntimes(rest, {
      connect: (capability, options) => connect(capability, options),
      out: (text) => process.stdout.write(`${text}\n`),
      err: (text) => process.stderr.write(`${text}\n`),
    });
  }
  if (group === "status") {
    return runStatus(rest, {
      connect: (capability, options) => connect(capability, options),
      out: (text) => process.stdout.write(`${text}\n`),
      err: (text) => process.stderr.write(`${text}\n`),
    });
  }
  if (group === "task") {
    return runTask(rest, {
      connect: (capability, options) => connect(capability, options),
      out: (text) => process.stdout.write(`${text}\n`),
      err: (text) => process.stderr.write(`${text}\n`),
    });
  }
  if (group === undefined || group === "help" || group === "--help" || group === "-h") {
    (group === undefined ? process.stderr : process.stdout).write(`${USAGE}\n`);
    return group === undefined ? 2 : 0;
  }
  process.stderr.write(`Unknown command group: ${group}\n\n${USAGE}\n`);
  return 2;
}

// Only when tsx runs this file (`pnpm -s aos`); bin/aos.mjs and tests import `main` instead.
if (process.argv[1] && /(?:^|[\\/])main\.ts$/.test(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
