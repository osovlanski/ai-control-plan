import type { AgentAdapter, AssistantId, CapabilityManifest, RunHandle, RunSpec } from "@agent-plane/core";
import type { NormalizedEvent, ProviderSessionRef } from "@agent-plane/core";
import { CodexAdapter } from "./codex.js";

export interface OpenRouterOptions {
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
}

/**
 * An OpenRouter model hosted inside the Codex coding-agent runtime.
 *
 * OpenRouter alone is an inference gateway, not a filesystem/shell agent. Using
 * Codex as the harness preserves the control plane's assistant-environment
 * boundary and normalized execution events.
 */
export class OpenRouterCodexAdapter implements AgentAdapter {
  readonly id: AssistantId;
  private delegate: CodexAdapter;
  private model: string;

  constructor(id: AssistantId, options: OpenRouterOptions = {}) {
    this.id = id;
    this.model = options.model ?? "stealth/ox-alpha";
    const baseUrl = options.baseUrl ?? "https://openrouter.ai/api/v1";
    const apiKeyEnv = options.apiKeyEnv ?? "OPENROUTER_API_KEY";
    this.delegate = new CodexAdapter(id, {
      provider: "openrouter",
      models: [{ id: this.model, displayName: this.model === "stealth/ox-alpha" ? "Ox Alpha (preview)" : this.model }],
      authEnvVars: [apiKeyEnv],
      providerDetail: {
        gateway: "openrouter",
        agentHarness: "codex",
        baseUrl,
        credentialEnv: apiKeyEnv,
        experimental: true,
      },
      codex: {
        config: {
          model_provider: "openrouter",
          model: this.model,
          model_reasoning_effort: options.reasoningEffort ?? "high",
          model_providers: {
            openrouter: {
              name: "OpenRouter",
              base_url: baseUrl,
              env_key: apiKeyEnv,
              wire_api: "responses",
            },
          },
        },
      },
    });
  }

  describe(): Promise<CapabilityManifest> { return this.delegate.describe(); }
  start(run: RunSpec): Promise<RunHandle> {
    return this.delegate.start({ ...run, model: run.model ?? { id: this.model } });
  }
  resume(ref: ProviderSessionRef, run: RunSpec): Promise<RunHandle> {
    return this.delegate.resume(ref, { ...run, model: run.model ?? { id: this.model } });
  }
  events(handle: RunHandle): AsyncIterable<NormalizedEvent> { return this.delegate.events(handle); }
  cancel(handle: RunHandle): Promise<void> { return this.delegate.cancel(handle); }
}
