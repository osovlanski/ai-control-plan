import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "eval/out/**",
      // Fixture files are sample workspaces the eval scenarios operate on —
      // data for the agent under test, not code in this codebase.
      "eval/fixtures/**",
      // Untracked agent worktrees are other checkouts, not this tree's code.
      "worktrees/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    // The M2 Composer is a pure function (plans/m2-composer.md §4.1): no clock, randomness,
    // environment, locale or I/O. Hashing is injected. A regression here fails `pnpm lint`.
    // The M6 asset-usage deriver is held to the same rule (m6 plan §2.2).
    files: ["packages/core/src/composer/**/*.ts", "packages/core/src/asset-telemetry.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        ...["Date", "process", "globalThis", "global", "window", "self", "performance", "Intl", "crypto", "fetch", "require", "setTimeout", "setInterval", "setImmediate", "queueMicrotask", "Buffer"].map(
          (name) => ({ name, message: "The Composer is pure: pass time, environment and hashing in through ComposerInputs or ComposerDeps." }),
        ),
      ],
      "no-restricted-properties": [
        "error",
        { object: "Math", property: "random", message: "The Composer is deterministic: no randomness." },
        ...["localeCompare", "toLocaleString", "toLocaleDateString", "toLocaleTimeString", "toLocaleUpperCase", "toLocaleLowerCase"].map(
          (property) => ({ property, message: "Locale-dependent output breaks determinism; compare by UTF-16 code units (byCodeUnit)." }),
        ),
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["node:*", "fs", "fs/*", "os", "path", "crypto", "child_process", "process", "util", "worker_threads", "http", "https", "net", "dns", "url"],
              message: "The Composer does no I/O: the api gathers inputs and implements the ports.",
            },
          ],
        },
      ],
      "no-restricted-syntax": ["error", { selector: "ImportExpression", message: "The Composer does no dynamic imports." }],
    },
  },
);
