import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, workspaceName } from "../src/config.js";
import { credentialPath, readCredential, rotateCredential } from "../src/auth/credential-file.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agent-plane-test-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const env = (overrides: Record<string, string> = {}) => ({
  AGENT_PLANE_HOME: home,
  ...overrides,
});

describe("workspace config", () => {
  it("defaults to the personal workspace", () => {
    expect(workspaceName(env())).toBe("personal");
  });

  it("rejects hostile workspace names", () => {
    expect(() => workspaceName(env({ AGENT_PLANE_WORKSPACE: "../escape" }))).toThrow();
  });

  it("creates a commented default config on first boot", () => {
    const config = loadConfig(env());
    expect(config.workspace).toBe("personal");
    expect(config.api.host).toBe("127.0.0.1"); // localhost by default (arch §12.6)
    expect(config.failover.auto).toBe(true);
    expect(config.dbPath).toBe(join(home, "personal", "agent-plane.db"));
    const written = readFileSync(join(home, "personal", "config.yaml"), "utf8");
    expect(written).toContain("never stored here");
    expect(lstatSync(config.dir).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(config.dir, "api-credential.json")).mode & 0o777).toBe(0o600);
    expect(config.api.auth).toEqual({ bootstrapTtlSeconds: 10, sessionTtlSeconds: 43200, rotationGraceSeconds: 300 });
  });

  it("merges auth TTL overrides", () => { const dir=join(home,"personal");mkdirSync(dir,{recursive:true});writeFileSync(join(dir,"config.yaml"),"api:\n  auth:\n    bootstrapTtlSeconds: 7\n    sessionTtlSeconds: 99\n    rotationGraceSeconds: 12\n");expect(loadConfig(env()).api.auth).toEqual({bootstrapTtlSeconds:7,sessionTtlSeconds:99,rotationGraceSeconds:12}); });

  it("refuses an unsafe credential file and symlink",()=>{const config=loadConfig(env());const path=join(config.dir,"api-credential.json");chmodSync(path,0o644);expect(()=>loadConfig(env())).toThrow(/Unsafe credential file/);rmSync(path);symlinkSync(join(config.dir,"config.yaml"),path);expect(()=>loadConfig(env())).toThrow(/Unsafe credential file/);});

  it("reclaims a stale dead-pid rotation lock but never steals a fresh live-pid lock", () => {
    const config = loadConfig(env());
    const path = credentialPath(config.dir);
    const lock = `${path}.lock`;
    writeFileSync(lock, JSON.stringify({ pid: 2_147_483_647, startedAt: new Date().toISOString() }), { mode: 0o600 });
    const before = readCredential(path).secrets.length;
    rotateCredential(path, config.api.auth.rotationGraceSeconds);
    expect(readCredential(path).secrets).toHaveLength(before + 1);
    expect(existsSync(lock)).toBe(false);

    writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
    expect(() => rotateCredential(path, config.api.auth.rotationGraceSeconds)).toThrow(/lock held/);
    expect(existsSync(lock)).toBe(true);
  });

  it("isolates workspaces into separate dirs and DB files", () => {
    const personal = loadConfig(env());
    const work = loadConfig(env({ AGENT_PLANE_WORKSPACE: "work" }));
    expect(work.dir).not.toBe(personal.dir);
    expect(work.dbPath).not.toBe(personal.dbPath);
  });

  it("merges a partial hand-edited file over defaults", () => {
    const dir = join(home, "personal");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.yaml"), "repoAllowlist:\n  - /repos/mine\nfailover:\n  auto: false\n");
    const config = loadConfig(env());
    expect(config.repoAllowlist).toEqual(["/repos/mine"]);
    expect(config.failover.auto).toBe(false);
    expect(config.failover.softThresholdPct).toBe(85); // default survives partial override
  });

  it("rejects invalid values loudly", () => {
    const dir = join(home, "personal");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.yaml"), "api:\n  port: 99999\n");
    expect(() => loadConfig(env())).toThrow(/api\.port/);
  });

  it("rejects non-loopback API binds until authenticated remote mode exists", () => {
    const dir = join(home, "personal");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.yaml"), "api:\n  host: 0.0.0.0\n  port: 4176\n");
    expect(() => loadConfig(env())).toThrow(/api\.host must be a loopback address/);
  });

  const writeCfg = (yaml: string) => {
    const dir = join(home, "personal");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.yaml"), yaml);
  };

  it("defaults execution.harnessModes.single OFF and documents it", () => {
    const config = loadConfig(env());
    expect(config.execution.harnessModes.single).toBe(false);
    expect(config.warnings).toEqual([]);
    const written = readFileSync(join(home, "personal", "config.yaml"), "utf8");
    expect(written).toContain("execution.harnessModes");
  });

  it("defaults OFF in a non-personal workspace too", () => {
    expect(loadConfig(env({ AGENT_PLANE_WORKSPACE: "work" })).execution.harnessModes.single).toBe(false);
  });

  describe("per-mode flag resolution matrix", () => {
    const cases: Array<{ name: string; yaml?: string; env?: Record<string, string>; single: boolean }> = [
      { name: "harnessModes.single: true", yaml: "execution:\n  harnessModes:\n    single: true\n", single: true },
      { name: "harnessModes.single: false", yaml: "execution:\n  harnessModes:\n    single: false\n", single: false },
      { name: "harnessModes: {} (partial)", yaml: "execution:\n  harnessModes: {}\n", single: false },
      { name: "legacy harnessSingleMode: true", yaml: "execution:\n  harnessSingleMode: true\n", single: true },
      { name: "legacy harnessSingleMode: false", yaml: "execution:\n  harnessSingleMode: false\n", single: false },
      { name: "env 1 over file false", yaml: "execution:\n  harnessModes:\n    single: false\n", env: { AGENT_PLANE_HARNESS_SINGLE_MODE: "1" }, single: true },
      { name: "env TRUE (uppercase) over legacy false", yaml: "execution:\n  harnessSingleMode: false\n", env: { AGENT_PLANE_HARNESS_SINGLE_MODE: "TRUE" }, single: true },
      { name: "env 0 over file true", yaml: "execution:\n  harnessModes:\n    single: true\n", env: { AGENT_PLANE_HARNESS_SINGLE_MODE: "0" }, single: false },
      { name: "env false over legacy true", yaml: "execution:\n  harnessSingleMode: true\n", env: { AGENT_PLANE_HARNESS_SINGLE_MODE: "false" }, single: false },
      { name: "env alone, no file", env: { AGENT_PLANE_HARNESS_SINGLE_MODE: "true" }, single: true },
      { name: "empty env string is a no-op", yaml: "execution:\n  harnessModes:\n    single: true\n", env: { AGENT_PLANE_HARNESS_SINGLE_MODE: "" }, single: true },
    ];
    for (const c of cases) {
      it(c.name, () => {
        if (c.yaml) writeCfg(c.yaml);
        expect(loadConfig(env(c.env)).execution.harnessModes.single).toBe(c.single);
      });
    }
  });

  it("a legacy harnessSingleMode file emits exactly one deprecation warning and never touches stdout", () => {
    writeCfg("execution:\n  harnessSingleMode: true\n");
    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const { warnings } = loadConfig(env());
      expect(warnings.filter((w) => /harnessSingleMode is deprecated/.test(w))).toHaveLength(1);
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }
    expect(spy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("rejects both execution.harnessModes and execution.harnessSingleMode set together", () => {
    writeCfg("execution:\n  harnessModes:\n    single: true\n  harnessSingleMode: true\n");
    expect(() => loadConfig(env())).toThrow(/not both/);
  });

  it("rejects an unknown execution.harnessModes key naming it", () => {
    for (const key of ["compare", "race", "parallel", "singel"]) {
      writeCfg(`execution:\n  harnessModes:\n    ${key}: true\n`);
      expect(() => loadConfig(env())).toThrow(new RegExp(`harnessModes\\.${key}`));
    }
  });

  it("rejects a non-boolean execution.harnessModes.single", () => {
    writeCfg("execution:\n  harnessModes:\n    single: yep\n");
    expect(() => loadConfig(env())).toThrow(/harnessModes\.single must be a boolean/);
  });

  it("rejects a non-boolean legacy execution.harnessSingleMode", () => {
    writeCfg("execution:\n  harnessSingleMode: yep\n");
    expect(() => loadConfig(env())).toThrow(/harnessSingleMode must be a boolean/);
  });

  it("rejects a malformed AGENT_PLANE_HARNESS_SINGLE_MODE value", () => {
    expect(() => loadConfig(env({ AGENT_PLANE_HARNESS_SINGLE_MODE: "maybe" }))).toThrow(
      /AGENT_PLANE_HARNESS_SINGLE_MODE must be one of/,
    );
  });

  it("rejects a non-mapping execution section", () => {
    writeCfg("execution: nope\n");
    expect(() => loadConfig(env())).toThrow(/execution must be a mapping/);
  });
});
