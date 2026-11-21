import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "./App.js";

afterEach(() => vi.unstubAllGlobals());
const render = (hash: string) => {
  vi.stubGlobal("window", { location: { hash } });
  return renderToStaticMarkup(<App />);
};

describe("public console wiring", () => {
  it("puts Missions in the rail beside Overview and Agents, with no mode switch", () => {
    const markup = render("#/overview");
    expect(markup).toMatch(/href="#\/overview" aria-current="page">.*Overview.*href="#\/shell">.*Missions.*href="#\/agents">/);
    expect(markup).not.toContain("Mission mode");
    expect(markup).not.toContain("Operator mode");
    expect(markup).not.toContain("Shell mode");
  });
  it("renders Missions through the alias and the legacy route, rail and all", () => {
    for (const path of ["#/shell", "#/mission", "#/shell/AG-123", "#/mission/AG-123"]) {
      const markup = render(path);
      expect(markup).toContain('aria-label="Mission workspace"');
      expect(markup).toContain('href="#/shell" aria-current="page"');
      expect(markup).toContain('aria-label="System"');
      expect(markup).not.toContain("Operator mode");
    }
  });
  it("keeps the system group behind More and marks More when a system page is open", () => {
    expect(render("#/overview")).toMatch(/aria-expanded="false" aria-controls="os-nav-system"/);
    expect(render("#/overview")).not.toContain("os-nav-more is-current");
    expect(render("#/tools")).toContain("os-nav-more is-current");
    expect(render("#/missions/AG-123")).toContain('href="#/shell" aria-current="page"');
  });
  it("rejects malformed mission alias IDs", () => {
    for (const path of ["#/mission/..", "#/mission/a%2Fb"]) {
      expect(render(path)).toContain("Page unavailable");
    }
  });
});
