import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TaskLinks, TaskProvenance } from "./api.js";
import { evidenceText, joinLabel, LinksSection, linksProblem, provenanceProblem, ProvenanceView } from "./TaskProvenance.js";

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
    const html = renderToStaticMarkup(<><ProvenanceView p={body()} /><LinksSection links={links} problem={null} /></>);
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
    const exactHtml = renderToStaticMarkup(<ProvenanceView p={exact} />);
    expect(exactHtml).not.toContain(rules.routingDecision.replace("'", "&#x27;"));
  });

  it("an unrecorded routing join stays unknown and is explained", () => {
    const p = body();
    p.runs[0]!.routingDecision = { id: null, source: "unrecorded", chosenAssistantId: null, at: null };
    const html = renderToStaticMarkup(<><ProvenanceView p={p} /><LinksSection links={{ taskId: "t1", links: [] }} problem={null} /></>);
    expect(html).toContain("no decision names this run");
    expect(html).toContain("the plane does not guess");
    expect(html).toContain("No issue or PR is linked");
  });

  it("refuses a body that would otherwise half-render or read as something it is not", () => {
    const cases: Array<[string, (b: Record<string, unknown> & TaskProvenance) => void, string]> = [
      ["unknown owner", (b) => { (b.owner as { kind: string }).kind = "robot"; }, "owner is missing or of an unknown kind"],
      ["no launch", (b) => { delete (b.runs[0] as Partial<TaskProvenance["runs"][0]>).launch; }, 'run "run_a" has no launch'],
      ["missing continuation", (b) => { delete (b.runs[0] as Partial<TaskProvenance["runs"][0]>).continuedFrom; }, 'run "run_a" has an unlabelled continuation'],
      ["no closed flag", (b) => { delete (b.handoffs[0] as Partial<TaskProvenance["handoffs"][0]>).closed; }, 'handoff "h_1" does not say whether it closed'],
      ["unknown record", (b) => { (b.handoffs[0] as { record: string }).record = "guess"; }, 'handoff "h_1" is neither a record nor an envelope'],
      ["no mode", (b) => { delete (b as Partial<TaskProvenance>).mode; }, "mode is missing"],
      ["inferred without rules", (b) => { (b as { inferenceRules: object }).inferenceRules = {}; }, "a join is inferred but no inference rule is served"],
    ];
    for (const [, mutate, why] of cases) {
      const b = body() as Record<string, unknown> & TaskProvenance;
      mutate(b);
      expect(provenanceProblem(b, "t1")).toBe(why);
    }
    // With no inferred join, an empty rule set is not a reason to refuse.
    const exact = body();
    exact.runs = [exact.runs[1]!];
    (exact as { inferenceRules: object }).inferenceRules = {};
    expect(provenanceProblem(exact, "t1")).toBeNull();
  });

  it("an envelope with no handoff record, an open handoff and a fresh start each read truthfully", () => {
    const p = body();
    p.runs = [p.runs[0]!];
    p.handoffs = [{
      id: "env_1", record: "envelope_only", trigger: null, at: "2030-01-01T10:05:30.000Z", checkpointId: "cp_1",
      from: { runId: "run_a", assistantId: "claude", source: "handoff_envelope" },
      to: { runId: null, assistantId: null }, closed: false,
      envelope: { id: "env_1", state: "parked", claimedByRequestId: null }, successorRoutingDecisionId: null,
    }];
    expect(provenanceProblem(p, "t1")).toBeNull();
    const html = renderToStaticMarkup(<ProvenanceView p={p} />);
    expect(html).toContain("Harness envelope with no handoff record");
    expect(html).not.toContain("trigger -");
    expect(html).toContain("OPEN: no successor has started");
    expect(html).toContain("to no run");
    expect(html).toContain("envelope env_1 (parked, unclaimed)");
    expect(html).not.toContain("successor decision");
    expect(html).toContain("Nothing (fresh start)");
    expect(html).toContain('data-source="handoff_envelope"');
  });

  it("numbers runs once, by the list, and names each item for the e2e locators", () => {
    const html = renderToStaticMarkup(<ProvenanceView p={body()} />);
    expect(html).toMatch(/<ol class="prov-list"><li class="prov-run" aria-label="Run run_a"><div><span class="mono">run_a<\/span>/);
    expect(html).not.toMatch(/>\s*\d+\.\s/);
    expect(html).toContain('aria-label="Handoff h_1"');
  });

  it("refuses a links body of another shape, and a failed read says why without hiding anything else", () => {
    expect(linksProblem(links, "t1")).toBeNull();
    expect(linksProblem({ error: "not found" }, "t1")).toBe("taskId is undefined");
    expect(linksProblem({ taskId: "t1" }, "t1")).toBe("links is not a list");
    expect(linksProblem({ taskId: "t1", links: [{ ...links.links[0]!, url: "javascript:alert(1)" }] }, "t1")).toBe("link osovlanski/ai-control-plan#42 has no GitHub URL");
    expect(linksProblem({ taskId: "t1", links: [{ ...links.links[0]!, evidence: [{ source: "rumour" }] }] }, "t1")).toBe("link osovlanski/ai-control-plan#42 has unlabelled evidence");
    expect(linksProblem({ taskId: "t1", links: [{ ...links.links[0]!, evidence: undefined }] }, "t1")).toBe("link osovlanski/ai-control-plan#42 has unlabelled evidence");
    const failed = renderToStaticMarkup(<LinksSection links={null} problem="Links unavailable in this read (HTTP 404)." />);
    expect(failed).toContain('aria-label="Linked issues and PRs"');
    expect(failed).toContain("Links unavailable in this read (HTTP 404).");
    expect(failed).not.toContain("No issue or PR is linked");
    expect(renderToStaticMarkup(<LinksSection links={null} problem={null} />)).toContain("Loading…");
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
