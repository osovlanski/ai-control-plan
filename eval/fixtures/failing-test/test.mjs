import assert from "node:assert/strict";
import { add } from "./src/add.mjs";

assert.equal(add(2, 3), 5, "add(2, 3) should be 5");
console.log("ok");
