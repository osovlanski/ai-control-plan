import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  it("defaults execution.harnessSingleMode OFF and documents it", () => {
    const config = loadConfig(env());
    expect(config.execution?.harnessSingleMode).toBe(false);
    const written = readFileSync(join(home, "personal", "config.yaml"), "utf8");
    expect(written).toContain("execution.harnessSingleMode");
  });

  it("defaults execution.harnessSingleMode OFF in a non-personal workspace too", () => {
    expect(loadConfig(env({ AGENT_PLANE_WORKSPACE: "work" })).execution?.harnessSingleMode).toBe(false);
  });

  it("parses execution.harnessSingleMode: true from the file", () => {
    const dir = join(home, "personal");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.yaml"), "execution:\n  harnessSingleMode: true\n");
    expect(loadConfig(env()).execution?.harnessSingleMode).toBe(true);
  });

  it("env AGENT_PLANE_HARNESS_SINGLE_MODE=1 overrides file false", () => {
    const dir = join(home, "personal");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.yaml"), "execution:\n  harnessSingleMode: false\n");
    expect(loadConfig(env({ AGENT_PLANE_HARNESS_SINGLE_MODE: "1" })).execution?.harnessSingleMode).toBe(true);
  });

  it("env AGENT_PLANE_HARNESS_SINGLE_MODE=0 overrides file true", () => {
    const dir = join(home, "personal");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.yaml"), "execution:\n  harnessSingleMode: true\n");
    expect(loadConfig(env({ AGENT_PLANE_HARNESS_SINGLE_MODE: "0" })).execution?.harnessSingleMode).toBe(false);
  });

  it("env AGENT_PLANE_HARNESS_SINGLE_MODE=true/false (word spellings) also override", () => {
    expect(loadConfig(env({ AGENT_PLANE_HARNESS_SINGLE_MODE: "true" })).execution?.harnessSingleMode).toBe(true);
    const dir = join(home, "personal");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.yaml"), "execution:\n  harnessSingleMode: true\n");
    expect(loadConfig(env({ AGENT_PLANE_HARNESS_SINGLE_MODE: "false" })).execution?.harnessSingleMode).toBe(false);
  });

  it("rejects a non-boolean execution.harnessSingleMode", () => {
    const dir = join(home, "personal");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.yaml"), "execution:\n  harnessSingleMode: yep\n");
    expect(() => loadConfig(env())).toThrow(/execution\.harnessSingleMode/);
  });

  it("rejects a non-mapping execution section", () => {
    const dir = join(home, "personal");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.yaml"), "execution: nope\n");
    expect(() => loadConfig(env())).toThrow(/execution must be a mapping/);
  });
});
