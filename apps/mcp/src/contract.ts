import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";

/** contracts/mcp-tools/v1, served verbatim on tools/list (minus `$id`/`$schema`, which clients' validators may not know). */
export const CONTRACT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "contracts", "mcp-tools", "v1");

export type ToolName = "list_tasks" | "get_task" | "create_task" | "start_task";
export type Scope = "aos.tasks.read" | "aos.tasks.create" | "aos.tasks.start";
export const SCOPES: readonly Scope[] = ["aos.tasks.read", "aos.tasks.create", "aos.tasks.start"];

interface ToolEntry {
  name: ToolName; title: string; requiredScope: Scope; description: string;
  annotations: Record<string, boolean>; inputSchema: string; outputSchema: string;
}

export interface ToolDefinition {
  name: ToolName; title: string; description: string; requiredScope: Scope;
  annotations: Record<string, boolean>;
  inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown>;
}

const read = (file: string) => JSON.parse(readFileSync(join(CONTRACT_DIR, file), "utf8")) as Record<string, unknown>;
const forClient = (schema: Record<string, unknown>) => {
  const { $id: _id, $schema: _schema, ...rest } = schema;
  return rest;
};

export interface Contract {
  tools: ToolDefinition[];
  scopeOf: Record<ToolName, Scope>;
  validateInput: Record<ToolName, ValidateFunction>;
  validateOutput: Record<ToolName, ValidateFunction>;
  validateError: ValidateFunction;
}

export function loadContract(): Contract {
  const index = read("tools.json") as unknown as { contract: string; tools: ToolEntry[] };
  if (index.contract !== "mcp-tools/v1") throw new Error(`unexpected contract ${index.contract}`);
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const tools: ToolDefinition[] = [];
  const validateInput = {} as Record<ToolName, ValidateFunction>;
  const validateOutput = {} as Record<ToolName, ValidateFunction>;
  const scopeOf = {} as Record<ToolName, Scope>;
  for (const t of index.tools) {
    const input = read(t.inputSchema);
    const output = read(t.outputSchema);
    validateInput[t.name] = ajv.compile(input);
    validateOutput[t.name] = ajv.compile(output);
    scopeOf[t.name] = t.requiredScope;
    tools.push({
      name: t.name, title: t.title, description: t.description, requiredScope: t.requiredScope,
      annotations: { ...t.annotations }, inputSchema: forClient(input), outputSchema: forClient(output),
    });
  }
  return { tools, scopeOf, validateInput, validateOutput, validateError: ajv.compile(read("tool-error.schema.json")) };
}
