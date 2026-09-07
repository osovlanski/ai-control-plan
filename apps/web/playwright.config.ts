import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  reporter: "line",
  // The demo walkthroughs drive a real in-process API + several deterministic
  // scheduler ticks and poll for state between each; the default 30s per-test
  // budget is too tight for them on a loaded CI box (Demo A runs ~35s).
  timeout: 120_000,
  projects: [
    {
      name: "chromium",
      testIgnore: /(demo-a|demo-a5|visual)\.spec\.ts/,
      use: { browserName: "chromium" },
    },
    {
      // Demo A: keeps reusable artefacts (trace, video, screenshots) for the runbook.
      name: "demo-a",
      testMatch: /demo-a\.spec\.ts/,
      use: {
        browserName: "chromium",
        viewport: { width: 1440, height: 1024 },
        trace: "on",
        video: "on",
        screenshot: "on",
      },
    },
    {
      // Visual reference captures for the operator console (docs + PR review).
      name: "visual",
      testMatch: /visual\.spec\.ts/,
      use: { browserName: "chromium", viewport: { width: 1440, height: 1000 } },
    },
    {
      // Demo A.5: K4 dependency waits + K5 recurring schedules end to end, with
      // reusable artefacts (trace, video, screenshots) for the runbook.
      name: "demo-a5",
      testMatch: /demo-a5\.spec\.ts/,
      use: {
        browserName: "chromium",
        viewport: { width: 1440, height: 1024 },
        trace: "on",
        video: "on",
        screenshot: "on",
      },
    },
  ],
});
