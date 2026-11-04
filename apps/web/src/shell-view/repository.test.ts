import { describe, expect, it, vi, afterEach } from "vitest";
import { readRepository, writeRepository, REPOSITORY_KEY } from "./repository.js";

afterEach(() => vi.unstubAllGlobals());
describe("repository preference", () => {
  it("remembers the chosen path and clears the choice", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    writeRepository("/scratch/repo", storage);
    expect(values.get(REPOSITORY_KEY)).toBe("/scratch/repo");
    expect(readRepository(storage)).toBe("/scratch/repo");
    writeRepository("", storage);
    expect(readRepository(storage)).toBe("");
  });
  it("survives absent storage, denied methods and a denied localStorage getter", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(readRepository()).toBe("");
    expect(() => writeRepository("/scratch/repo")).not.toThrow();
    const blocked = { getItem: () => { throw Error("blocked"); }, setItem: () => { throw Error("blocked"); } };
    expect(readRepository(blocked)).toBe("");
    expect(() => writeRepository("/scratch/repo", blocked)).not.toThrow();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw Error("blocked"); } });
    expect(readRepository()).toBe("");
    expect(() => writeRepository("/scratch/repo")).not.toThrow();
  });
});
