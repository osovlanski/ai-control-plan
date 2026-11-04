import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "./App.js";

afterEach(() => vi.unstubAllGlobals());
const render = (hash: string) => {
  vi.stubGlobal("window", { location: { hash } });
  return renderToStaticMarkup(<App />);
};

describe("public console wiring", () => {
  it("names the older mode Mission while retaining its original destination", () => {
    expect(render("#/overview")).toContain('href="#/shell">Mission mode</a>');
    expect(render("#/overview")).not.toContain("Shell mode");
  });
  it("renders Mission mode through the alias and the legacy route", () => {
    for (const path of ["#/shell", "#/mission", "#/shell/AG-123", "#/mission/AG-123"]) {
      const markup = render(path);
      expect(markup).toContain('aria-label="Mission workspace"');
      expect(markup).toContain('href="#/overview">Operator mode</a>');
    }
  });
  it("rejects malformed mission alias IDs", () => {
    for (const path of ["#/mission/..", "#/mission/a%2Fb"]) {
      expect(render(path)).toContain("Page unavailable");
    }
  });
});
