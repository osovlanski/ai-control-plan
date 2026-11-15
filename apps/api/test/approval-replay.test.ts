import { describe, expect, it } from "vitest";
import { stricterApproval } from "../src/modules/harness/control-plane-bridge.js";

describe("a replayed saved request under a changed baseline", () => {
  it("tightens to the current baseline and never loosens", () => {
    expect(stricterApproval("auto-approve", "prompt-on-escalation")).toBe("prompt-on-escalation");
    expect(stricterApproval("auto-approve", "read-only")).toBe("read-only");
    expect(stricterApproval("prompt-on-escalation", "auto-approve")).toBe("prompt-on-escalation");
    expect(stricterApproval("read-only", "auto-approve")).toBe("read-only");
    expect(stricterApproval("auto-approve", "auto-approve")).toBe("auto-approve");
  });
});
