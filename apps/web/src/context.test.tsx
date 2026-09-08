/**
 * M14 K9 — the context gauge renders exactly one of the truthful states and
 * never invents a percentage.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TaskContext } from "./api.js";
import { ContextReadout } from "./board/readouts.js";

const base = (o: Partial<NonNullable<TaskContext["observation"]>> = {}): TaskContext => ({
  status: "known",
  sessionId: "es_1",
  capability: {
    occupancy: "provider-reported",
    effectiveWindow: "provider-reported",
    compact: "none",
    autoManagement: "provider",
    observesAutoCompaction: true,
  },
  observation: {
    sequence: 1,
    observedAt: "2026-09-08T10:00:00.000Z",
    occupancyTokens: 82_000,
    occupancySource: "provider-reported",
    effectiveWindowTokens: 180_000,
    effectiveWindowSource: "provider-reported",
    pressure: 82_000 / 180_000,
    freshness: "live",
    ...o,
  },
  autoCompaction: { observed: false, count: 0 },
});

describe("ContextReadout", () => {
  it("KNOWN: shows occupancy / window, a percentage, the method chip and Live", () => {
    const html = renderToStaticMarkup(<ContextReadout context={base({ advertisedMaxTokens: 1_000_000 })} />);
    expect(html).toContain("82k / 180k tokens");
    expect(html).toContain("46%");
    expect(html).toContain("Provider-reported");
    expect(html).toContain("Live");
    // Advertised maximum is shown separately from the effective window.
    expect(html).toContain("Advertised model maximum: 1,000,000");
  });

  it("PARTIAL: occupancy known, window unknown → tokens only, NO percentage", () => {
    const html = renderToStaticMarkup(
      <ContextReadout
        context={base({ effectiveWindowTokens: undefined, effectiveWindowSource: "unavailable", pressure: undefined })}
      />,
    );
    expect(html).toContain("82k tokens");
    expect(html).toContain("Effective window unknown");
    expect(html).not.toContain("%");
    expect(html).not.toContain("<meter");
  });

  it("UNAVAILABLE: no observation → occupancy unavailable + reason, no percentage", () => {
    const html = renderToStaticMarkup(
      <ContextReadout
        context={{
          status: "unavailable",
          sessionId: "es_1",
          reason: "codex does not expose live context occupancy",
          capability: {
            occupancy: "unavailable",
            effectiveWindow: "unavailable",
            compact: "none",
            autoManagement: "provider",
            autoManagementDetail: "Codex manages its own context",
            observesAutoCompaction: false,
          },
        }}
      />,
    );
    expect(html).toContain("Occupancy unavailable");
    expect(html).toContain("does not expose live context occupancy");
    expect(html).toContain("Codex manages its own context");
    expect(html).not.toContain("%");
  });

  it("LEGACY: explicit legacy-path message", () => {
    const html = renderToStaticMarkup(
      <ContextReadout context={{ status: "unavailable", sessionId: "es_1", reason: "legacy execution path" }} />,
    );
    expect(html).toContain("Context observation unavailable — legacy execution path");
  });

  it("STALE: renders Stale, not Live, and shows no percentage", () => {
    const html = renderToStaticMarkup(<ContextReadout context={base({ freshness: "stale", pressure: undefined })} />);
    expect(html).toContain("Stale");
    expect(html).not.toContain(">Live<");
    expect(html).toContain("stale — pressure is not shown");
    expect(html).not.toContain("<meter");
  });

  it("auto-compaction shows as Observed, never as an Agentic OS action", () => {
    const ctx = base();
    ctx.autoCompaction = { observed: true, count: 2, lastAt: "2026-09-08T10:00:00.000Z", trigger: "auto" };
    const html = renderToStaticMarkup(<ContextReadout context={ctx} />);
    expect(html).toContain("Observed");
    expect(html).toContain("not an Agentic OS action");
  });
});
