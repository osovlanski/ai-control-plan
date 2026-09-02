import { describe, expectTypeOf, it } from "vitest";
import type {
  ExecutionRequestId,
  ExecutionSessionId,
  RepositoryId,
  WorkspaceId,
  WorktreeId,
} from "../src/ids.js";

describe("stable execution identity contracts", () => {
  it("does not permit identity domains to be interchanged", () => {
    expectTypeOf<WorkspaceId>().not.toEqualTypeOf<RepositoryId>();
    expectTypeOf<RepositoryId>().not.toEqualTypeOf<WorktreeId>();
    expectTypeOf<ExecutionRequestId>().not.toEqualTypeOf<ExecutionSessionId>();
  });
});
