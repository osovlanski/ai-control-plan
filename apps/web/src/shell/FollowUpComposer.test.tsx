/**
 * The composer's two invariants: it is unchanged while the capability is off,
 * and its wording never claims more than the plane recorded.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionInput } from "../api.js";
import { FollowUpComposer, canRetry, deliveryLabel } from "./FollowUpComposer.js";

const input = (over: Partial<SessionInput> = {}): SessionInput => ({
  id: "msg_1", sessionId: "run_1", taskId: "AG-1", clientMessageId: "c1", text: "hi",
  state: "queued", reason: null, deliveryUnknown: false, version: 1,
  createdAt: "2026-09-20T09:00:00.000Z", updatedAt: "2026-09-20T09:00:00.000Z",
  providerReceipt: null, ...over,
});

describe("follow-up composer", () => {
  it("stays disabled and says so when the capability is off", () => {
    const html = renderToStaticMarkup(<FollowUpComposer enabled={false} sessionId="run_1" />);
    expect(html).toContain("Session-addressed text delivery is not available yet.");
    expect(html).toContain("disabled");
    expect(html).not.toContain("Send");
  });

  it("stays disabled when the capability is on but there is no live session", () => {
    const html = renderToStaticMarkup(<FollowUpComposer enabled sessionId={undefined} />);
    expect(html).toContain("No live session to address.");
    expect(html).toContain("disabled");
  });

  it("offers a send addressed to the live session when the capability is on", () => {
    const html = renderToStaticMarkup(<FollowUpComposer enabled sessionId="run_1" />);
    expect(html).toContain("Addressing session run_1");
    expect(html).toContain("Send");
  });

  it("never renders an unconfirmed delivery as sent", () => {
    expect(deliveryLabel(input({ state: "queued", reason: "approval_pending" })))
      .toBe("Recorded · waiting to send (approval_pending)");
    expect(deliveryLabel(input({ state: "accepted" }))).toBe("Sending · confirmation pending");
    expect(deliveryLabel(input({ state: "accepted", deliveryUnknown: true })))
      .toBe("Sent, but delivery could not be confirmed");
    expect(deliveryLabel(input({ state: "rejected", reason: "session_completed:COMPLETED" })))
      .toBe("Not delivered · session_completed:COMPLETED");
    expect(deliveryLabel(input({ state: "expired" }))).toBe("Expired · not delivered");
  });

  it("claims provider receipt only when the plane recorded one", () => {
    const delivered = input({
      state: "delivered",
      providerReceipt: { reference: "fake-receipt-1", ackLevel: "provider-accepted", at: "2026-09-20T09:00:01.000Z" },
    });
    expect(deliveryLabel(delivered)).toBe("Provider confirmed receipt (provider-accepted)");
  });

  it("offers a retry only while the message is unsettled", () => {
    expect(canRetry(input({ state: "queued" }))).toBe(true);
    expect(canRetry(input({ state: "accepted", deliveryUnknown: true }))).toBe(true);
    for (const state of ["delivered", "rejected", "expired"] as const) {
      expect(canRetry(input({ state }))).toBe(false);
    }
  });
});
