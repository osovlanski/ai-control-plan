import { NotSupportedError, type PermissionPolicy } from "@agent-plane/core";

/**
 * Workspace approval mode → Codex sandbox and approval settings, shared by the
 * SDK (`codex exec`) and app-server paths. Values checked against
 * @openai/codex-sdk 0.154.0 `ThreadOptions` (`SandboxMode`, `ApprovalMode`),
 * which the SDK passes as `--sandbox <mode>` and `approval_policy="<policy>"`.
 *
 * - auto-approve → `workspace-write`, `never`: writes inside the workdir, no
 *   escalation (behaviour unchanged).
 * - read-only → `read-only`, `never`: the sandbox refuses writes and nothing
 *   can escalate out of it.
 * - prompt-on-escalation → refused. Neither path implements an approval
 *   round trip (no `send`, approvalPolicy is always `never`), so an
 *   escalation could never reach a human. Running anyway would grant more
 *   than the workspace allows; picking read-only would silently change the mode.
 */
export function codexPermissions(policy: PermissionPolicy): { sandboxMode: "read-only" | "workspace-write"; approvalPolicy: "never" } {
  switch (policy.mode) {
    case "auto-approve":
      return { sandboxMode: "workspace-write", approvalPolicy: "never" };
    case "read-only":
      return { sandboxMode: "read-only", approvalPolicy: "never" };
    case "prompt-on-escalation":
      throw new NotSupportedError(
        "approval mode prompt-on-escalation (Codex runs have no approval relay; use auto-approve or read-only)",
      );
  }
}
