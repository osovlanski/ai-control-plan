import { lstatSync, readFileSync } from "node:fs";

/**
 * Reads a secret-bearing file only when it is a regular file (not a symlink) owned by this user
 * with no group/other bits, the same rule the plane applies to its credential files.
 * The content is never logged.
 */
export function readPrivateFile(path: string): string {
  const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o077) !== 0) {
    throw new Error(`Unsafe secret file ${path}; it must be a regular file owned by this user with mode 0600`);
  }
  return readFileSync(path, "utf8");
}

interface CredentialSecret { kid: string; secret: string; capabilities: string[]; notAfter: string | null }

/** The newest active secret of a plane credential file (`api-credential.<name>.json`, plane C1). */
export function readPlaneSecret(path: string, now = new Date()): { kid: string; secret: string; capabilities: string[] } {
  const value = JSON.parse(readPrivateFile(path)) as { version?: number; secrets?: CredentialSecret[] };
  if (value.version !== 1 || !Array.isArray(value.secrets)) throw new Error(`Invalid plane credential file ${path}`);
  const active = value.secrets.filter((s) => s && typeof s.secret === "string" && (s.notAfter === null || Date.parse(s.notAfter) > now.getTime()));
  const last = active.at(-1);
  if (!last) throw new Error(`Plane credential file ${path} holds no active secret`);
  return { kid: last.kid, secret: last.secret, capabilities: [...last.capabilities] };
}
