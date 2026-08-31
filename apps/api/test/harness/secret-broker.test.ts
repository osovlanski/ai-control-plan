/**
 * Phase 5 — SecretBroker (execution-harness §3): the single named owner of
 * secret resolution at the launch boundary. Capability-scoped to the accepted
 * request's refs; values live only in memory; errors name the reference, never
 * the value; no partial env on failure; dispose() is final.
 */
import { describe, expect, it } from "vitest";
import {
  SecretBroker,
  SecretResolutionError,
} from "../../src/modules/harness/secret-broker.js";

/** A canary string that is not shaped like any real credential. */
const CANARY = "canary-value-abcdefghijklmno";

describe("SecretBroker", () => {
  it("resolves an allowed ref into an env map, applying refToEnvName", () => {
    const broker = new SecretBroker((ref) => (ref === "PRIMARY_REF" ? CANARY : undefined), [
      "PRIMARY_REF",
    ]);
    const env = broker.resolve(["PRIMARY_REF"], (r) => `PROVIDER_${r}`);
    expect(env).toEqual({ PROVIDER_PRIMARY_REF: CANARY });
  });

  it("defaults refToEnvName to the ref itself", () => {
    const broker = new SecretBroker(() => CANARY, ["REF_A"]);
    expect(broker.resolve(["REF_A"])).toEqual({ REF_A: CANARY });
  });

  it("refuses a ref that is not in the accepted request's allowlist", () => {
    const broker = new SecretBroker(() => CANARY, ["ALLOWED"]);
    let err: unknown;
    try {
      broker.resolve(["NOT_ALLOWED"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SecretResolutionError);
    expect((err as SecretResolutionError).ref).toBe("NOT_ALLOWED");
    expect((err as Error).message).toContain("NOT_ALLOWED");
    expect((err as Error).message).not.toContain(CANARY);
  });

  it("fails the whole call with no partial env when one ref cannot be resolved", () => {
    const seen: string[] = [];
    const broker = new SecretBroker((ref) => {
      seen.push(ref);
      return ref === "A" ? CANARY : undefined; // B resolves to undefined
    }, ["A", "B"]);

    expect(() => broker.resolve(["A", "B"])).toThrow(SecretResolutionError);
    // A was consulted, B failed — but the caller gets nothing back at all.
    expect(seen).toEqual(["A", "B"]);
  });

  it("treats an empty-string value as unresolved (names the ref, not the value)", () => {
    const broker = new SecretBroker(() => "", ["EMPTY"]);
    expect(() => broker.resolve(["EMPTY"])).toThrow(/secret reference "EMPTY"/);
  });

  it("dispose() clears resolved values and blocks any further resolve", () => {
    const broker = new SecretBroker(() => CANARY, ["REF_A"]);
    broker.resolve(["REF_A"]);
    broker.dispose();
    expect(() => broker.resolve(["REF_A"])).toThrow("already disposed");
  });
});
