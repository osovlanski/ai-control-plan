/**
 * SecretBroker — the single named owner of secret resolution at the launch
 * boundary (execution-harness §3).
 *
 * `ProviderSessionDriver` asks the broker to resolve the request's secret
 * *references* immediately before `adapter.start()`. Values:
 *   - exist only in memory (a per-call Map that is cleared by `dispose()`);
 *   - are injected into the provider launch environment by the adapter;
 *   - are EXCLUDED from the reduced verification environment (the
 *     WorkspaceAuthority rebuilds env from an allowlist, so this holds by
 *     construction);
 *   - never appear in the persisted request, the fingerprint, or any
 *     diagnostic — broker errors name the reference, never the value;
 *   - are dropped after launch.
 *
 * Capability-scoped: the broker resolves ONLY references named by the accepted
 * request (`allowedRefs`). Anything else is refused even if the resolver could
 * produce it.
 */

export type SecretResolver = (ref: string) => string | undefined;

export class SecretResolutionError extends Error {
  constructor(
    readonly ref: string,
    reason: string,
  ) {
    // Names the reference, never the value.
    super(`secret reference "${ref}" ${reason}`);
    this.name = "SecretResolutionError";
  }
}

export class SecretBroker {
  private resolved = new Map<string, string>();
  private disposed = false;

  constructor(
    private resolver: SecretResolver,
    /** The references this request is permitted to resolve. */
    private allowedRefs: readonly string[],
  ) {}

  /**
   * Resolve the requested references into an env map. Every requested ref must be
   * in `allowedRefs` AND produce a value, or the call fails as a whole (no
   * partial env). `refToEnvName` maps a reference to the launch env var name it
   * populates (default: the ref itself).
   */
  resolve(
    refs: readonly string[],
    refToEnvName: (ref: string) => string = (r) => r,
  ): Record<string, string> {
    if (this.disposed) throw new Error("SecretBroker already disposed");
    const env: Record<string, string> = {};
    for (const ref of refs) {
      if (!this.allowedRefs.includes(ref)) {
        throw new SecretResolutionError(ref, "is not in this request's allowed secret references");
      }
      const value = this.resolver(ref);
      if (value === undefined || value === "") {
        throw new SecretResolutionError(ref, "could not be resolved");
      }
      this.resolved.set(ref, value);
      env[refToEnvName(ref)] = value;
    }
    return env;
  }

  /** Drop every resolved value. Called by the driver right after launch. */
  dispose(): void {
    this.resolved.clear();
    this.disposed = true;
  }
}
