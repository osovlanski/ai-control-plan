#!/usr/bin/env node
/**
 * `pnpm eval:promote` (plan §4 step 23). Commits the JSON+MD scorecard pair
 * from the last `pnpm eval` run into `docs/eval-history/` — never on every
 * nightly, only from `workflow_dispatch` or this explicit command.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const outDir = fileURLToPath(new URL("./out/", import.meta.url));
const jsonPath = `${outDir}scorecard.json`;
const mdPath = `${outDir}scorecard.md`;

if (!existsSync(jsonPath) || !existsSync(mdPath)) {
  console.error(`No scorecard at ${outDir} — run \`pnpm eval\` first.`);
  process.exit(1);
}

const card = JSON.parse(readFileSync(jsonPath, "utf8")) as { generatedAt: string };
const date = card.generatedAt.slice(0, 10);
const historyDir = fileURLToPath(new URL("../docs/eval-history/", import.meta.url));
mkdirSync(historyDir, { recursive: true });
copyFileSync(jsonPath, `${historyDir}scorecard-${date}.json`);
copyFileSync(mdPath, `${historyDir}scorecard-${date}.md`);
console.log(`Promoted to docs/eval-history/scorecard-${date}.{json,md}`);
