import { describe, expect, it } from "vitest";
import { APPLICATIONS, readRoute } from "./routes.js";

describe("application routes", () => {
  it("defaults to Overview and round-trips all seven applications", () => {
    expect(readRoute("").screen).toBe("overview");
    expect(APPLICATIONS).toHaveLength(7);
    for (const { screen } of APPLICATIONS) expect(readRoute(`#/${screen}`).screen).toBe(screen);
  });
  it("addresses Shell history and an existing mission without path traversal", () => {
    expect(readRoute("#/shell")).toMatchObject({ screen: "shell" });
    expect(readRoute("#/shell/AG-123")).toMatchObject({ screen: "shell", taskId: "AG-123" });
    for (const path of ["%", "a%2Fb", "..", "a/b"]) expect(readRoute(`#/shell/${path}`).screen).toBe("unavailable");
  });
  it("keeps a durable mission destination and rejects malformed/path IDs", () => {
    expect(readRoute("#/missions/AG-123")).toMatchObject({ screen: "mission", taskId: "AG-123" });
    for (const hash of ["#/unknown", "#/missions/%", "#/missions/a%2Fb", "#/missions/.."]) {
      expect(readRoute(hash).screen).toBe("unavailable");
    }
  });
});
