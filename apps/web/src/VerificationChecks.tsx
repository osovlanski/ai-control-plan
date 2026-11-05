import type { VerificationView } from "./api.js";
import { verificationCheckView, verificationVerdict } from "./orbital.js";

/** Aggregate verdict: the plane's `passed`, read with blocked/skipped counts. */
export function VerificationVerdict({ verification }: { verification: VerificationView }) {
  const v = verificationVerdict(verification);
  const extra = [v.blocked && v.label !== "blocked" ? `${v.blocked} blocked` : "", v.skipped ? `${v.skipped} skipped` : ""]
    .filter(Boolean)
    .join(", ");
  return (
    <>
      <strong data-testid="verification-verdict">{v.label}</strong>
      {extra && ` (${extra})`}
    </>
  );
}

/** Per-check rows. A check with no `status` keeps the passed/failed reading. */
export function VerificationChecks({ verification }: { verification: VerificationView }) {
  if (verification.checks.length === 0) return null;
  return (
    <ul className="verification-checks" aria-label="Verification checks">
      {verification.checks.map((check, i) => {
        const view = verificationCheckView(check);
        return (
          <li key={check.checkId ?? `${check.name}-${i}`} data-status={view.label}>
            <strong className={view.tone}>{view.label}</strong> <span className="mono">{check.name}</span>
            {!view.required && <span className="fine-print"> · not required</span>}
            {view.detail && <div className="verification-check-detail">{view.detail}</div>}
          </li>
        );
      })}
    </ul>
  );
}
