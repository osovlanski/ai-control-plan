/**
 * Autopilot state v1 (docs/contracts/autopilot-state-v1.md, API 2.21): `GET /api/autopilot/state`.
 *
 * Read-only and `tasks.read`, like `GET /api/autopilot`. It reuses the autopilot, dispatcher and
 * restore status readers as they are, projects them through core `projectAutopilotState` (which
 * redacts free text) and validates the body against the JSON Schema under
 * contracts/autopilot-state/v1 before it leaves: a snapshot that does not conform is a 500, never
 * sent. `GET /api/autopilot` keeps its own, unversioned shape for the plane's web UI.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import type { FastifyInstance } from "fastify";
import { projectAutopilotState, type AutopilotStateSources, type AutopilotStateV1 } from "@agent-plane/core";
import { formatSchemaErrors } from "../bundle-contract.js";
import type { ContractResult } from "../registry-contract.js";
import type { AutopilotService } from "./autopilot.js";
import type { AutopilotDispatcher } from "./autopilot-dispatcher.js";
import type { AutopilotRestore } from "./autopilot-restore.js";

// ajv-formats is CJS; under bundler resolution its default lands on `.default`.
const addFormats = ((addFormatsImport as unknown as { default?: unknown }).default ?? addFormatsImport) as (ajv: Ajv2020) => void;

export const AUTOPILOT_STATE_CONTRACT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../../contracts/autopilot-state/v1");
export const AUTOPILOT_STATE_ROUTE = "/api/autopilot/state";

let compiled: (((body: unknown) => boolean) & { errors?: ErrorObject[] | null }) | undefined;
function validator() {
  if (!compiled) {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    addFormats(ajv);
    compiled = ajv.compile(JSON.parse(readFileSync(join(AUTOPILOT_STATE_CONTRACT_DIR, "autopilot-state.schema.json"), "utf8")));
  }
  return compiled;
}

/** Validates a body against autopilot state v1. */
export function validateAutopilotState(body: unknown): ContractResult<AutopilotStateV1> {
  const validate = validator();
  if (validate(body)) return { ok: true, value: body as AutopilotStateV1 };
  return { ok: false, errors: formatSchemaErrors(validate.errors) };
}

export interface AutopilotStateDeps {
  autopilot: Pick<AutopilotService, "status" | "windows" | "attempts" | "externals">;
  dispatcher: Pick<AutopilotDispatcher, "status">;
  restore: Pick<AutopilotRestore, "status">;
  now: () => Date;
}

/** One snapshot from the plane's readers. Each reader is called once. */
export function readAutopilotState(d: AutopilotStateDeps): AutopilotStateV1 {
  const sources: AutopilotStateSources = {
    status: d.autopilot.status(),
    windows: d.autopilot.windows(),
    attempts: d.autopilot.attempts(20),
    dispatcher: d.dispatcher.status(),
    restore: d.restore.status(),
    openExternals: d.autopilot.externals().length,
  };
  return projectAutopilotState(sources, d.now().toISOString());
}

/** Registers `GET /api/autopilot/state` under `guard` (the route's auth config, `tasks.read`). */
export function registerAutopilotStateRoute(app: FastifyInstance, guard: { config: { auth: { require: string } } }, d: AutopilotStateDeps): void {
  app.get(AUTOPILOT_STATE_ROUTE, guard, (req, reply) => {
    const body = readAutopilotState(d);
    const checked = validateAutopilotState(body);
    if (!checked.ok) {
      // Error paths only: a detail could quote redacted free text.
      req.log.error({ errors: checked.errors.map((e) => e.split(":")[0]) }, "autopilot state failed its own contract");
      return reply.status(500).send({ error: "autopilot state failed the autopilot-state v1 contract" });
    }
    return body;
  });
}
