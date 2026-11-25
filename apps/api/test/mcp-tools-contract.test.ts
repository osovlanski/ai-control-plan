/**
 * mcp-tools v1 conformance (docs/adr/mcp-connector.md, C1 acceptance 8): every fixture under
 * `contracts/mcp-tools/v1/fixtures/<schema stem>/{valid,invalid}/` passes or fails the named schema
 * under strict Ajv2020, and `tools.json` names only schemas that exist and compile.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";

const CONTRACT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "contracts", "mcp-tools", "v1");
const json = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

describe("mcp-tools v1 contract", () => {
  const stems = readdirSync(join(CONTRACT, "fixtures")).sort();

  it("has fixtures for every schema in the directory, valid and invalid", () => {
    const schemas = readdirSync(CONTRACT).filter((f) => f.endsWith(".schema.json")).map((f) => f.replace(/\.schema\.json$/, "")).sort();
    expect(stems).toEqual(schemas);
    for (const stem of stems) {
      for (const kind of ["valid", "invalid"]) expect([stem, kind, readdirSync(join(CONTRACT, "fixtures", stem, kind)).length > 0]).toEqual([stem, kind, true]);
    }
  });

  it.each(stems)("%s: fixtures pass and fail the schema as named under strict Ajv2020", (stem) => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    const validate = ajv.compile(json(join(CONTRACT, `${stem}.schema.json`)));
    for (const kind of ["valid", "invalid"] as const) {
      for (const name of readdirSync(join(CONTRACT, "fixtures", stem, kind))) {
        const body = json(join(CONTRACT, "fixtures", stem, kind, name));
        expect([kind, name, validate(body)]).toEqual([kind, name, kind === "valid"]);
      }
    }
  });

  it("tools.json lists the four tools with existing schemas, and each schema is closed and self-contained", () => {
    const tools = json(join(CONTRACT, "tools.json")).tools as Array<{ name: string; inputSchema: string; outputSchema: string; requiredScope: string }>;
    expect(tools.map((t) => t.name)).toEqual(["list_tasks", "get_task", "create_task", "start_task"]);
    for (const t of tools) {
      for (const file of [t.inputSchema, t.outputSchema]) {
        expect([file, existsSync(join(CONTRACT, file))]).toEqual([file, true]);
        const schema = readFileSync(join(CONTRACT, file), "utf8");
        expect([file, schema.includes('"$ref"')]).toEqual([file, false]);
        expect([file, (JSON.parse(schema) as { additionalProperties?: unknown }).additionalProperties]).toEqual([file, false]);
      }
      expect(t.requiredScope).toMatch(/^aos\.tasks\.(read|create|start)$/);
    }
  });
});
