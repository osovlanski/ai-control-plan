import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  reporter: "line",
  projects: [
    {
      name: "chromium",
      testIgnore: /(demo-a|visual)\.spec\.ts/,
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
  ],
});
