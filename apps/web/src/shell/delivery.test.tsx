/**
 * The delivery vocabulary and the composer that uses it.
 *
 * Two invariants: the composer is unchanged while the capability is off, and no
 * surface's wording ever claims more than the plane recorded — which is why
 * `manual_recovery_required` is named rather than softened.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionInput } from "../api.js";
import { FollowUpComposer } from "./FollowUpComposer.js";
import {
  canCommandCancel, canCommandRetry, canRetry, deliveryGuidance, deliveryLabel, deliveryTone, needsManualRecovery,
} from "./delivery.js";

const input = (over: Partial<SessionInput> = {}): SessionInput => ({
  id: "msg_1", sessionId: "run_1", taskId: "AG-1", clientMessageId: "c1", text: "hi",
  state: "queued", reason: null, deliveryUnknown: false, generation: 1, version: 1,
  createdAt: "2026-09-20T09:00:00.000Z", updatedAt: "2026-09-20T09:00:00.000Z",
  providerReceipt: null, ...over,
});

describe("follow-up composer and delivery vocabulary", () => {
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

  it("calls a send a retry only while the plane holds an unsettled row for this draft", () => {
    // The composer reads its own row from the ledger rather than remembering
    // what it sent, so a reload cannot make it offer a second first-send.
    const html = renderToStaticMarkup(<FollowUpComposer enabled sessionId="run_1" inputs={[]} />);
    expect(html).toContain("Send");
    expect(html).not.toContain("Retry this message");
  });

  it("shows no delivery state of its own — the transcript owns it", () => {
    const html = renderToStaticMarkup(<FollowUpComposer enabled sessionId="run_1"
      inputs={[input({ state: "accepted", deliveryUnknown: true, reason: "manual_recovery_required" })]} />);
    expect(html).not.toContain("needs manual recovery");
    expect(html).not.toContain("Retry this delivery");
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

  it("names manual recovery instead of softening it into an unconfirmed send", () => {
    const stuck = input({ state: "accepted", deliveryUnknown: true, reason: "manual_recovery_required" });
    expect(needsManualRecovery(stuck)).toBe(true);
    expect(deliveryLabel(stuck)).toBe("Delivery unresolved · needs manual recovery");
    // The tone that means "a person is needed", not the one that means success.
    expect(deliveryTone(stuck)).toBe("tone-human");
    expect(deliveryGuidance(stuck)).toContain("will not resend");
    // Every OTHER unresolved row carries its attempt's diagnostic as `reason`,
    // so the verdict is an equality test and never "has a reason".
    const unknown = input({ state: "accepted", deliveryUnknown: true, reason: "fake acknowledgement lost in transport" });
    expect(needsManualRecovery(unknown)).toBe(false);
    expect(deliveryGuidance(unknown)).toBeNull();
    expect(deliveryLabel(unknown)).toBe("Sent, but delivery could not be confirmed (fake acknowledgement lost in transport)");
  });

  it("never tones an unsettled record as delivered", () => {
    expect(deliveryTone(input({ state: "delivered" }))).toBe("tone-complete");
    expect(deliveryTone(input({ state: "rejected" }))).toBe("tone-failed");
    expect(deliveryTone(input({ state: "expired" }))).toBe("tone-failed");
    expect(deliveryTone(input({ state: "queued" }))).toBe("tone-resource");
    expect(deliveryTone(input({ state: "accepted" }))).toBe("tone-active");
    expect(deliveryTone(input({ state: "accepted", deliveryUnknown: true }))).toBe("tone-limit");
  });

  it("claims provider receipt only when the plane recorded one", () => {
    const delivered = input({
      state: "delivered",
      providerReceipt: { reference: "fake-receipt-1", ackLevel: "provider-accepted", at: "2026-09-20T09:00:01.000Z" },
    });
    expect(deliveryLabel(delivered)).toBe("Provider confirmed receipt (provider-accepted)");
  });

  it("offers the explicit commands only where the plane accepts them", () => {
    // Mirrors the plane's own rules, so the UI never offers a button that will
    // come back 409. A live attempt offers neither: its outcome is unknown.
    expect(canCommandRetry(input({ state: "rejected" }))).toBe(true);
    expect(canCommandRetry(input({ state: "accepted", deliveryUnknown: true }))).toBe(true);
    expect(canCommandRetry(input({ state: "accepted" }))).toBe(false);
    expect(canCommandRetry(input({ state: "queued" }))).toBe(false);
    expect(canCommandCancel(input({ state: "queued" }))).toBe(true);
    for (const state of ["accepted", "delivered", "rejected", "expired"] as const) {
      expect(canCommandCancel(input({ state }))).toBe(false);
    }
  });

  it("offers a retry only while the message is unsettled", () => {
    expect(canRetry(input({ state: "queued" }))).toBe(true);
    expect(canRetry(input({ state: "accepted", deliveryUnknown: true }))).toBe(true);
    for (const state of ["delivered", "rejected", "expired"] as const) {
      expect(canRetry(input({ state }))).toBe(false);
    }
  });
});
