import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api.js";

afterEach(() => vi.unstubAllGlobals());

describe("web API client", () => {
  it("returns workspace data from the versioned local API", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ workspace: "personal" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.workspace()).resolves.toMatchObject({ workspace: "personal" });
    expect(fetchMock).toHaveBeenCalledWith("/api/workspace", expect.any(Object));
  });

  it("surfaces the API error message for failed workflows", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "No eligible assistant" }), {
      status: 422,
      headers: { "content-type": "application/json" },
    })));

    await expect(api.start("task-1")).rejects.toThrow("No eligible assistant");
  });
});
