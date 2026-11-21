# mcp-tools v1

Tool contract for the owner-only MCP connector (`apps/mcp`, not built yet). Normative text and
access model: [docs/adr/mcp-connector.md](../../../docs/adr/mcp-connector.md).

- `tools.json` lists the four tools (`list_tasks`, `get_task`, `create_task`, `start_task`), their
  annotations, required OAuth scope and the schema files below.
- `<tool>.input.schema.json` is the tool's `inputSchema`; `<tool>.output.schema.json` is its
  `outputSchema` (the shape of `structuredContent` on success). `tool-error.schema.json` is the
  `structuredContent` of a result with `isError: true`.
- Every schema is JSON Schema draft 2020-12, `type: object`, closed (`additionalProperties: false`)
  and self-contained (no `$ref`), because MCP clients receive it verbatim on `tools/list`.
- `fixtures/<schema stem>/{valid,invalid}/` must pass and fail the named schema under
  `new Ajv2020({ strict: true, allErrors: true })`. C1 adds the conformance test that runs them.

Not covered here: the plane's HTTP request/response shapes for idempotent create/start (C1 owns
them, API 2.14) and the OAuth endpoints (standard RFC shapes, C2).
