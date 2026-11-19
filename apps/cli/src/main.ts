#!/usr/bin/env node
/**
 * `aos`: the operator CLI over the Control Plane's own routes. Run it with `pnpm aos …` from the
 * repository root. Only `aos runtimes` exists so far (Agent Runtime Registry PR 6); the rest of
 * backlog `p1-3-aos-cli` (create, stream, approve, stop) is later work.
 */
import { connect } from "./client.js";
import { runRuntimes, USAGE as RUNTIMES_USAGE } from "./runtimes.js";

const USAGE = `usage: aos <group> <command> [options]

Groups:
  runtimes    the runtime catalogue, lifecycle, sync, test, disable and enable

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
  if (group === undefined || group === "help" || group === "--help" || group === "-h") {
    (group === undefined ? process.stderr : process.stdout).write(`${USAGE}\n`);
    return group === undefined ? 2 : 0;
  }
  process.stderr.write(`Unknown command group: ${group}\n\n${USAGE}\n`);
  return 2;
}

process.exitCode = await main(process.argv.slice(2));
