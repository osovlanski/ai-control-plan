/**
 * M1 composition store: immutable AgentSpec revisions, their CompositionDecision, and the bundle
 * each was composed with (docs/contracts/composition-v1.md). Every write is validated against the
 * composition and bundle v1 reference validators, including checkComposition's digest agreement;
 * the tables' triggers refuse any UPDATE or DELETE, so there is no edit path.
 */
import type { Db } from "../db/index.js";
import { validateBundleRequest, validateBundleResponse, type BundleRequest, type BundleResponse } from "../bundle-contract.js";
import {
  checkComposition, validateAgentSpec, validateCompositionDecision, type AgentSpec, type CompositionDecision,
} from "../composition-contract.js";

export class CompositionError extends Error {
  constructor(readonly errors: string[]) {
    super(`composition rejected: ${errors.join("; ")}`);
  }
}

export interface CompositionRevision {
  spec: AgentSpec;
  decision: CompositionDecision;
  bundle: { request: BundleRequest; response: BundleResponse };
}

export class CompositionStore {
  constructor(private db: Db, private now: () => Date = () => new Date()) {}

  /** Persists one revision atomically, or throws CompositionError and writes nothing. */
  persist(input: { spec: unknown; decision: unknown; bundle: { request: unknown; response: unknown } }): CompositionRevision {
    // The bundle is required: context.bundle_digest binds it and the revision is replayed from it.
    if (!input.bundle) throw new CompositionError(["bundle is required"]);
    const spec = validateAgentSpec(input.spec);
    const decision = validateCompositionDecision(input.decision);
    const request = validateBundleRequest(input.bundle.request);
    const response = request.ok ? validateBundleResponse(input.bundle.response, request.value) : validateBundleResponse(input.bundle.response);
    const errors = [
      ...(spec.ok ? [] : spec.errors.map((e) => `spec ${e}`)),
      ...(decision.ok ? [] : decision.errors.map((e) => `decision ${e}`)),
      ...(request.ok ? [] : request.errors.map((e) => `bundle request ${e}`)),
      ...(response.ok ? [] : response.errors.map((e) => `bundle response ${e}`)),
    ];
    if (!spec.ok || !decision.ok || !request.ok || !response.ok) throw new CompositionError(errors);
    const revision = { spec: spec.value, decision: decision.value, bundle: { request: request.value, response: response.value } };
    const mismatch = checkComposition(revision.spec, revision.decision, revision.bundle);
    if (mismatch.length) throw new CompositionError(mismatch);
    if (!this.db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(revision.spec.task_id)) {
      throw new CompositionError([`task ${revision.spec.task_id} does not exist`]);
    }
    if (this.db.prepare("SELECT 1 FROM agent_specs WHERE composition_revision_id = ?").get(revision.spec.composition_revision_id)) {
      throw new CompositionError([`composition revision ${revision.spec.composition_revision_id} already exists; compose a new revision`]);
    }
    if (this.db.prepare("SELECT 1 FROM composition_decisions WHERE id = ?").get(revision.decision.id)) {
      throw new CompositionError([`composition decision ${revision.decision.id} already explains another revision`]);
    }
    const at = this.now().toISOString();
    this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO agent_specs (composition_revision_id, task_id, schema_version, explanation_ref, bundle_digest,
           spec_json, bundle_request_json, bundle_response_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        revision.spec.composition_revision_id, revision.spec.task_id, revision.spec.schema_version, revision.spec.explanation_ref,
        revision.spec.context.bundle_digest, JSON.stringify(revision.spec), JSON.stringify(revision.bundle.request),
        JSON.stringify(revision.bundle.response), at,
      );
      this.db.prepare("INSERT INTO composition_decisions (id, composition_revision_id, decision_json, created_at) VALUES (?, ?, ?, ?)")
        .run(revision.decision.id, revision.spec.composition_revision_id, JSON.stringify(revision.decision), at);
    })();
    return revision;
  }

  get(compositionRevisionId: string): CompositionRevision | undefined {
    const row = this.db.prepare(
      `SELECT s.spec_json, s.bundle_request_json, s.bundle_response_json, d.decision_json
         FROM agent_specs s JOIN composition_decisions d ON d.composition_revision_id = s.composition_revision_id
        WHERE s.composition_revision_id = ?`,
    ).get(compositionRevisionId) as { spec_json: string; bundle_request_json: string; bundle_response_json: string; decision_json: string } | undefined;
    if (!row) return undefined;
    return {
      spec: JSON.parse(row.spec_json) as AgentSpec,
      decision: JSON.parse(row.decision_json) as CompositionDecision,
      bundle: { request: JSON.parse(row.bundle_request_json) as BundleRequest, response: JSON.parse(row.bundle_response_json) as BundleResponse },
    };
  }

  /** Binds a run to a revision of its own task. Write-once: a bound run never moves. */
  attachRun(runId: string, compositionRevisionId: string): void {
    const run = this.db.prepare("SELECT task_id, composition_revision_id FROM runs WHERE id = ?").get(runId) as
      | { task_id: string; composition_revision_id: string | null } | undefined;
    if (!run) throw new CompositionError([`run ${runId} does not exist`]);
    const spec = this.db.prepare("SELECT task_id FROM agent_specs WHERE composition_revision_id = ?").get(compositionRevisionId) as
      | { task_id: string } | undefined;
    if (!spec) throw new CompositionError([`composition revision ${compositionRevisionId} does not exist`]);
    if (spec.task_id !== run.task_id) throw new CompositionError([`revision ${compositionRevisionId} composes task ${spec.task_id}, not the run's task ${run.task_id}`]);
    if (run.composition_revision_id === compositionRevisionId) return;
    if (run.composition_revision_id) throw new CompositionError([`run ${runId} is already bound to ${run.composition_revision_id}`]);
    this.db.prepare("UPDATE runs SET composition_revision_id = ? WHERE id = ? AND composition_revision_id IS NULL").run(compositionRevisionId, runId);
  }
}
