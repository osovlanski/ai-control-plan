import {
  newRepositoryId,
  newWorkspaceId,
  newWorktreeId,
  normalizeRemoteIdentity,
  type RepositoryId,
  type WorkspaceId,
  type WorktreeId,
} from "@agent-plane/core";
import type { Db } from "../db/index.js";
import { inspectGitRepositoryIdentity } from "./git.js";

export interface ResolvedRepositoryIdentity {
  workspaceId: WorkspaceId;
  repositoryId: RepositoryId;
  worktreeId: WorktreeId;
  remoteConflict: boolean;
}

export class RepositoryIdentityRegistry {
  constructor(private readonly db: Db) {}

  async resolve(repoPath: string): Promise<ResolvedRepositoryIdentity> {
    const observed = await inspectGitRepositoryIdentity(repoPath);
    const selected = observed.remotes.find((remote) => remote.name === "origin") ?? observed.remotes[0];
    const normalized = selected ? normalizeRemoteIdentity(selected.url) : { kind: "unsupported" as const };
    const remoteFingerprint = normalized.kind === "normalized" ? normalized.fingerprint : null;
    const now = new Date().toISOString();

    return this.db.transaction(() => {
      const workspaceId = this.workspace(now);
      let repository = this.db
        .prepare("SELECT id, remote_fingerprint FROM repository_identities WHERE workspace_id = ? AND canonical_git_dir = ?")
        .get(workspaceId, observed.canonicalGitDir) as
        | { id: RepositoryId; remote_fingerprint: string | null }
        | undefined;
      if (!repository) {
        const candidate = newRepositoryId();
        this.db
          .prepare("INSERT OR IGNORE INTO repository_identities (id, workspace_id, canonical_git_dir, remote_fingerprint, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(candidate, workspaceId, observed.canonicalGitDir, remoteFingerprint, now);
        repository = this.db
          .prepare("SELECT id, remote_fingerprint FROM repository_identities WHERE workspace_id = ? AND canonical_git_dir = ?")
          .get(workspaceId, observed.canonicalGitDir) as { id: RepositoryId; remote_fingerprint: string | null };
      }
      if (repository.remote_fingerprint === null && remoteFingerprint !== null) {
        this.db
          .prepare("UPDATE repository_identities SET remote_fingerprint = ? WHERE id = ? AND remote_fingerprint IS NULL")
          .run(remoteFingerprint, repository.id);
        repository.remote_fingerprint = remoteFingerprint;
      }

      const remoteConflict =
        remoteFingerprint !== null &&
        repository.remote_fingerprint !== null &&
        remoteFingerprint !== repository.remote_fingerprint;
      this.db
        .prepare("INSERT INTO repository_identity_observations (repository_id, observed_path, observed_remote_fingerprint, source, conflict, observed_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(
          repository.id,
          observed.canonicalToplevel,
          remoteFingerprint,
          selected?.name ?? "none",
          remoteConflict ? 1 : 0,
          now,
        );

      let worktree = this.db
        .prepare("SELECT id FROM worktree_identities WHERE repository_id = ? AND canonical_toplevel = ?")
        .get(repository.id, observed.canonicalToplevel) as { id: WorktreeId } | undefined;
      if (!worktree) {
        const candidate = newWorktreeId();
        this.db
          .prepare("INSERT OR IGNORE INTO worktree_identities (id, repository_id, canonical_toplevel, created_at) VALUES (?, ?, ?, ?)")
          .run(candidate, repository.id, observed.canonicalToplevel, now);
        worktree = this.db
          .prepare("SELECT id FROM worktree_identities WHERE repository_id = ? AND canonical_toplevel = ?")
          .get(repository.id, observed.canonicalToplevel) as { id: WorktreeId };
      }
      return { workspaceId, repositoryId: repository.id, worktreeId: worktree.id, remoteConflict };
    })();
  }

  private workspace(now: string): WorkspaceId {
    const existing = this.db.prepare("SELECT id FROM workspace_identities WHERE singleton = 1").get() as
      | { id: WorkspaceId }
      | undefined;
    if (existing) return existing.id;
    const candidate = newWorkspaceId();
    this.db
      .prepare("INSERT OR IGNORE INTO workspace_identities (singleton, id, created_at) VALUES (1, ?, ?)")
      .run(candidate, now);
    return (this.db.prepare("SELECT id FROM workspace_identities WHERE singleton = 1").get() as { id: WorkspaceId }).id;
  }
}
