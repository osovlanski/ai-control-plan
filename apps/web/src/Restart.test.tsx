import { describe, expect, it } from "vitest";
import { namesRestartRoute } from "./Restart.js";

describe("namesRestartRoute", () => {
  it("is true only for an error that names the restart route", () => {
    expect(namesRestartRoute("session did not settle; use POST /api/tasks/AG-1/restart")).toBe(true);
    expect(namesRestartRoute("Recovery cannot release this session; use POST /api/tasks/example/restart")).toBe(true);
    expect(namesRestartRoute("handoff refused: target disabled")).toBe(false);
    expect(namesRestartRoute("POST /api/tasks/AG-1/restartable")).toBe(false);
  });
});
