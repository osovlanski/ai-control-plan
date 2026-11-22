import { describe, expect, it } from "vitest";
import { spendRows } from "./TaskEstimate.js";

describe("spendRows (qcq-03)", () => {
  it("labels API spend, API-equivalent and subscription quota apart, and never shows API-equivalent as spend", () => {
    const rows = Object.fromEntries(spendRows({
      billing: "subscription", billingBasis: "provider default", apiUsd: null,
      apiEquivalentUsd: { low: 0.5, typical: 1.25, high: 3 },
      subscriptionQuota: { bucket: "five_hour", usedPercent: 82, resetsAt: null, observedAt: "2030-01-06T08:00:00Z", perRunShare: "unknown" },
    }));
    expect(rows["API spend"]).toBe("n/a (not API-billed)");
    expect(rows["API-equivalent (not spend)"]).toBe("$0.5000 / $1.25 / $3.00");
    expect(rows["Subscription quota"]).toBe("five_hour at 82%; per-run share unknown");
  });

  it("an API-billed runtime shows spend and no API-equivalent; missing evidence stays unknown", () => {
    const rows = Object.fromEntries(spendRows({ billing: "api", billingBasis: "provider default", apiUsd: null, apiEquivalentUsd: null, subscriptionQuota: null }));
    expect(rows["API spend"]).toBe("unknown");
    expect(rows["API-equivalent (not spend)"]).toBe("n/a (not subscription-billed)");
    expect(rows["Subscription quota"]).toBe("no fresh observation");
  });
});

describe("approvalText (qcq-03)", () => {
  it("shows the wait range only when comparable runs waited", async () => {
    const { approvalText } = await import("./TaskEstimate.js");
    expect(approvalText({ pending: 0, required: false, historicalShare: 0, historicalMs: null })).toBe("0 pending · no comparable run waited");
    expect(approvalText({ pending: 1, required: true, historicalShare: 0.5, historicalMs: { low: 60_000, typical: 120_000, high: 600_000 } }))
      .toBe("1 pending · one required before start · 50% of comparable runs waited 1 min / 2 min / 10 min");
    expect(approvalText({ pending: 0, required: false, historicalShare: null, historicalMs: null })).toBe("0 pending");
  });
});
