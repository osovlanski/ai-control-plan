import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TaskLinks, TaskProvenance } from "./api.js";
import { evidenceText, joinLabel, provenanceProblem, ProvenanceView } from "./TaskProvenance.js";

const rules = {
  routingDecision: "latest routing decision for the task that chose the run's assistant, made at or before the run started, and not already bound to another run",
  predecessor: "the run of the task that started most recently before this one",
};

function body(): TaskProvenance {
  return {
    taskId: "t1",
    owner: { kind: "operator", runAs: null },
    mode: "single",
    runs: [
      {
        runId: "run_a", assistantId: "claude", executionPath: "legacy", executionRequestId: null, attempt: null,
        startedAt: "2030-01-01T10:00:00.000Z", endedAt: "2030-01-01T10:05:00.000Z", settlementOwner: "legacy",
        compositionRevisionId: null, promptSource: null,
        launch: { kind: "operator", dispatch: null, handoffTrigger: null },
        routingDecision: { id: 1, source: "inferred", chosenAssistantId: "claude", at: "2030-01-01T09:59:00.000Z" },
        continuedFrom: null,
      },
      {
        runId: "run_b", assistantId: "codex", executionPath: "harness", executionRequestId: "req_b", attempt: 1,
        startedAt: "2030-01-01T10:06:00.000Z", endedAt: null, settlementOwner: null,
        compositionRevisionId: "rev_1", promptSource: "handoff",
        launch: { kind: "handoff", dispatch: null, handoffTrigger: "limit" },
        routingDecision: { id: 2, source: "execution_request", chosenAssistantId: "codex", at: "2030-01-01T10:06:00.000Z" },
        continuedFrom: { runId: "run_a", assistantId: "claude", source: "handoff_record", checkpointId: "cp_1", handoffId: "h_1", envelopeId: null },
      },
    ],
    handoffs: [{
      id: "h_1", record: "handoff", trigger: "limit", at: "2030-01-01T10:05:30.000Z", checkpointId: "cp_1",
      from: { runId: "run_a", assistantId: "claude", source: "handoff_record" },
      to: { runId: "run_b", assistantId: "codex" }, closed: true, envelope: null, successorRoutingDecisionId: 2,
    }],
    inferenceRules: rules,
  };
}

const links: TaskLinks = { taskId: "t1", links: [{
  kind: "pull_request", repo: "osovlanski/ai-control-plan", number: 42, url: "https://github.com/osovlanski/ai-control-plan/pull/42",
  evidence: [{ source: "operator", linkId: "l1", relation: "implements", note: "FAKE note", createdBy: null, createdAt: "2030-01-01T11:00:00.000Z" }],
}] };

describe("task provenance (tlm-03 web)", () => {
  it("labels a stored key, an inferred join and an unrecorded one apart, with the CLI's words", () => {
    expect(joinLabel("execution_request")).toEqual({ text: "via execution_request", kind: "key" });
    expect(joinLabel("inferred")).toEqual({ text: "INFERRED", kind: "inferred" });
    expect(joinLabel("unrecorded")).toEqual({ text: "UNRECORDED", kind: "unrecorded" });
  });

  it("refuses a body that is not the API 2.12 shape instead of showing it", () => {
    expect(provenanceProblem(body(), "t1")).toBeNull();
    expect(provenanceProblem({ error: "not found" }, "t1")).toBe('taskId is undefined');
    expect(provenanceProblem(body(), "t2")).toBe('taskId is "t1"');
    const bad = body();
    (bad.runs[0]!.routingDecision as { source: string }).source = "guess";
    expect(provenanceProblem(bad, "t1")).toBe('run "run_a" has no labelled routing decision');
  });

  it("renders runs, the handoff, links and the inference rules only because a join is inferred", () => {
    const html = renderToStaticMarkup(<ProvenanceView p={body()} links={links} linksError={false} />);
    expect(html).toContain('data-source="inferred"');
    expect(html).toContain('data-source="execution_request"');
    expect(html).toContain("Handoff (trigger limit)");
    expect(html).toContain("Legacy (no execution request)");
    expect(html).toContain(rules.routingDecision.replace("'", "&#x27;"));
    expect(html).not.toContain("the plane does not guess");
    expect(html).toContain('href="https://github.com/osovlanski/ai-control-plan/pull/42"');
    expect(html).toContain("not checked against GitHub");

    const exact = body();
    exact.runs = [exact.runs[1]!];
    const exactHtml = renderToStaticMarkup(<ProvenanceView p={exact} links={null} linksError={true} />);
    expect(exactHtml).not.toContain(rules.routingDecision.replace("'", "&#x27;"));
    expect(exactHtml).toContain("Links unavailable");
  });

  it("an unrecorded routing join stays unknown and is explained", () => {
    const p = body();
    p.runs[0]!.routingDecision = { id: null, source: "unrecorded", chosenAssistantId: null, at: null };
    const html = renderToStaticMarkup(<ProvenanceView p={p} links={{ taskId: "t1", links: [] }} linksError={false} />);
    expect(html).toContain("no decision names this run");
    expect(html).toContain("the plane does not guess");
    expect(html).toContain("No issue or PR is linked");
  });

  it("describes autopilot evidence as derived, not as an operator claim", () => {
    expect(evidenceText({ source: "autopilot_publication", publicationId: "pub_1", attemptId: "a1", state: "opened", head: "auto/x", base: "main", verifiedSha: "0123456789abcdef", at: "2030-01-01T00:00:00Z" }))
      .toBe("Autopilot publication pub_1 (opened) · auto/x → main · verified 0123456789ab");
    expect(evidenceText({ source: "autopilot_duplicate", publicationId: "pub_1", attemptId: "a1", prState: "open", at: "2030-01-01T00:00:00Z" }))
      .toBe("Autopilot found an existing PR (open) for publication pub_1");
  });
});

describe("ruleName", () => {
  it("spaces the served rule key for reading", async () => {
    const { ruleName } = await import("./TaskProvenance.js");
    expect(ruleName("routingDecision")).toBe("Routing decision");
    expect(ruleName("predecessor")).toBe("Predecessor");
  });
});
