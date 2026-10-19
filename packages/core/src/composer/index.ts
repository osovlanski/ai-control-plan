/** The M2 Composer's public surface (plans/m2-composer.md §1). Stage modules stay internal. */
export * from "./types.js";
export { createTextGuard, guarded, WITHHELD, type TextGuard } from "./text-guard.js";
export { compositionDigest, OVERRIDE_ACTOR, OVERRIDE_REASON } from "./explain.js";
export { INTENT_KINDS } from "./intent.js";
export { candidateRef, harnessForProvider } from "./harness-model.js";
export { ASSET_FILTERS, type AssetFilterName } from "./assets.js";
export { BUNDLE_HARNESSES, effectiveTokenBudget, isBundleHarness } from "./context.js";
export { PERMISSIONS, policyDocument, toApprovalMode, toPermission } from "./policy.js";
export * from "./accounting.js";
export { composerInputsDigest, MAX_RENDERS, runComposer } from "./pipeline.js";
