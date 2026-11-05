import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { VerificationChecks, VerificationVerdict } from "./VerificationChecks.js";

describe("verification checks", () => {
  it("renders skipped with its reason, blocked with its install command, and a legacy check as passed/failed", () => {
    const html = renderToStaticMarkup(
      <VerificationChecks verification={{ passed: false, checks: [
        { checkId: "project:test", name: "project test", required: false, status: "skipped", passed: false, summary: "project verification skipped: the run changed nothing" },
        { checkId: "project:lint", name: "project lint", required: true, status: "blocked", passed: false, summary: "blocked: run `npm ci` in the worktree" },
        { name: "build", required: true, passed: false, summary: "exit 1" },
      ] }} />,
    );
    expect(html).toContain('data-status="skipped"');
    expect(html).toContain("the run changed nothing");
    expect(html).toContain("not required");
    expect(html).toContain('data-status="blocked"');
    expect(html).toContain("run `npm ci` in the worktree");
    expect(html).toContain('data-status="failed"');
    expect(renderToStaticMarkup(<VerificationChecks verification={{ passed: true, checks: [] }} />)).toBe("");
  });

  it("the verdict names blocked and counts skipped", () => {
    const blocked = renderToStaticMarkup(<VerificationVerdict verification={{ passed: false, checks: [
      { name: "t", required: true, status: "blocked", passed: false, summary: "" },
      { name: "s", required: false, status: "skipped", passed: false, summary: "" },
    ] }} />);
    expect(blocked).toContain(">blocked</strong>");
    expect(blocked).toContain("(1 skipped)");
    const passed = renderToStaticMarkup(<VerificationVerdict verification={{ passed: true, checks: [{ name: "b", required: true, passed: true, summary: "ok" }] }} />);
    expect(passed).toContain(">passed</strong>");
    expect(passed).not.toContain("(");
  });
});
