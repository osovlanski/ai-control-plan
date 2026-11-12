/**
 * P0-A2 (docs/agentic-os-auto-copilot-plan.md §C.0): the operator secret.
 *
 * `autopilot.operate` starts, releases and resolves the autopilot. Its secret is not in the
 * credential file and is never written to this machine by the plane: only its SHA-256 lives
 * here, so a process that reads every file the plane user owns still cannot start the autopilot.
 * The secret is 32 random bytes, so a plain digest is enough (there is nothing to stretch).
 * Stopping is deliberately not behind it.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { registerSecret } from "@agent-plane/core";

export interface OperateSecretFile { version: 1; kid: string; hash: string; createdAt: string }
export const operateSecretPath = (dir: string) => join(dir, "autopilot-operate.json");
const HASH = /^sha256:[0-9a-f]{64}$/;
/** The generated form. A caller-supplied secret must be at least this long to be accepted by the bin. */
export const OPERATE_SECRET_PREFIX = "aop_";

export const hashOperateSecret = (secret: string) => `sha256:${createHash("sha256").update(secret, "utf8").digest("hex")}`;

/** The stored hash, or undefined when none is set (then nothing can hold `autopilot.operate`). Throws on an unsafe or corrupt file. */
export function readOperateSecret(path: string): OperateSecretFile | undefined {
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) {
    throw new Error(`Unsafe operator secret file ${path}; run: chmod 600 ${path} && chown $(id -u) ${path}`);
  }
  const value = JSON.parse(readFileSync(path, "utf8")) as OperateSecretFile;
  if (value.version !== 1 || typeof value.kid !== "string" || !HASH.test(value.hash)) throw new Error(`Invalid operator secret file ${path}`);
  return value;
}

/** Store `hash` (replacing any earlier one: there is no grace period for this secret). */
export function writeOperateSecretHash(path: string, hash: string, now = new Date()): OperateSecretFile {
  if (!HASH.test(hash)) throw new Error("operator secret hash must be sha256:<64 lowercase hex>");
  const value: OperateSecretFile = { version: 1, kid: `op_${randomBytes(4).toString("hex")}`, hash, createdAt: now.toISOString() };
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  const fd = openSync(tmp, "r"); fsyncSync(fd); closeSync(fd);
  renameSync(tmp, path);
  const dfd = openSync(dirname(path), "r"); fsyncSync(dfd); closeSync(dfd);
  return value;
}

/** A fresh secret and its hash. The secret is returned to the caller once and stored nowhere. */
export function generateOperateSecret(): { secret: string; hash: string } {
  const secret = `${OPERATE_SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
  registerSecret(secret);
  return { secret, hash: hashOperateSecret(secret) };
}

/** `kid` of the stored hash when `raw` is the operator secret; undefined otherwise, and whenever the file is unusable. */
export function matchOperateSecret(path: string, raw: string): string | undefined {
  let file: OperateSecretFile | undefined;
  try {
    file = readOperateSecret(path);
  } catch {
    return undefined; // fail closed: an unsafe file grants nothing
  }
  if (!file) return undefined;
  const a = Buffer.from(hashOperateSecret(raw));
  const b = Buffer.from(file.hash);
  return a.length === b.length && timingSafeEqual(a, b) ? file.kid : undefined;
}
