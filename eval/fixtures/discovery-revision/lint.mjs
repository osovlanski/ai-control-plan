import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./src/clean.mjs", import.meta.url), "utf8");
if (src.includes("TODO")) {
  console.error("lint: src/clean.mjs still has a TODO marker");
  process.exit(1);
}
console.log("lint: ok");
