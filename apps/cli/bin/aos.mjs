#!/usr/bin/env node
// `aos` as a package bin (F1): `pnpm exec aos …` (or node_modules/.bin/aos) runs the CLI with no
// pnpm script banner on stdout, so `aos … --json | jq` parses. tsx loads the TypeScript source.
import process from "node:process";
import { register } from "tsx/esm/api";

register();
const { main } = await import("../src/main.ts");
process.exitCode = await main(process.argv.slice(2));
