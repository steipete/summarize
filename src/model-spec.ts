import type { CliProvider } from "./config.js";
import { normalizeGatewayStyleModelId, parseGatewayStyleModelId } from "./llm/model-id.js";
import {
  type RequiredModelEnv,
  requiredEnvForCliProvider,
  resolveRequiredEnvForModelId,
} from "./llm/provider-capabilities.js";

const DEFAULT_CLI_MODELS: Record<CliProvider, string | null> = {
  claude: "sonnet",
  codex: "gpt-5.2",
  gemini: "gemini-3-flash",
  agent: "gpt-5.2",
  openclaw: "main",
  opencode: null,
};

export type FixedModelSpec =
  | {
      transport: "native";
      userModelId: string;
      llmModelId: string;
      provider: "xai" | "openai" | "google" | "anthropic" | "zai" | "nvidia";
      openrouterProviders: string[] | null;
      forceOpenRouter: false;
      requiredEnv:
        | "XAI_API_KEY"
        | "OPENAI_API_KEY"
        | "GEMINI_API_KEY"
        | "ANTHROPIC_API_KEY"
        | "Z_AI_API_KEY"
        | "NVIDIA_API_KEY";
      openaiBaseUrlOverride?: string | null;
      forceChatCompletions?: boolean;
    }
  | {
      transport: "openrouter";
      userModelId: string;
      openrouterModelId: string;
      llmModelId: string;
      openrouterProviders: string[] | null;
      forceOpenRouter: true;
      requiredEnv: "OPENROUTER_API_KEY";
    }
  | {
      transport: "cli";
      userModelId: string;
      llmModelId: null;
      openrouterProviders: null;
      forceOpenRouter: false;
      requiredEnv:
        | "CLI_CLAUDE"
        | "CLI_CODEX"
        | "CLI_GEMINI"
        | "CLI_AGENT"
        | "CLI_OPENCLAW"
        | "CLI_OPENCODE";
      cliProvider: CliProvider;
      cliModel: string | null;
    };

export type RequestedModel = { kind: "auto" } | ({ kind: "fixed" } & FixedModelSpec);

export function parseRequestedModelId(raw: string): RequestedModel {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new Error("Missing model id");

  const lower = trimmed.toLowerCase();
  if (lower === "auto") return { kind: "auto" };

  if (lower.startsWith("openrouter/")) {
    const openrouterModelId = trimmed.slice("openrouter/".length).trim();
    if (openrouterModelId.length === 0) {
      throw new Error("Invalid model id: openrouter/… is missing the OpenRouter model id");
    }
    if (!openrouterModelId.includes("/")) {
      throw new Error(
        `Invalid OpenRouter model id "${openrouterModelId}". Expected "author/slug" (e.g. "openai/gpt-5-mini").`,
      );
    }
    return {
      kind: "fixed",
      transport: "openrouter",
      userModelId: `openrouter/${openrouterModelId}`,
      openrouterModelId,
      llmModelId: `openai/${openrouterModelId}`,
      openrouterProviders: null,
      forceOpenRouter: true,
      requiredEnv: "OPENROUTER_API_KEY",
    };
  }

  if (lower.startsWith("zai/")) {
    const model = trimmed.slice("zai/".length).trim();
    if (model.length === 0) {
      throw new Error("Invalid model id: zai/… is missing the model id");
    }
    return {
      kind: "fixed",
      transport: "native",
      userModelId: `zai/${model}`,
      llmModelId: `zai/${model}`,
      provider: "zai",
      openrouterProviders: null,
      forceOpenRouter: false,
      requiredEnv: "Z_AI_API_KEY",
      openaiBaseUrlOverride: "https://api.z.ai/api/paas/v4",
      forceChatCompletions: true,
    };
  }

  if (lower.startsWith("nvidia/")) {
    const model = trimmed.slice("nvidia/".length).trim();
    if (model.length === 0) {
      throw new Error("Invalid model id: nvidia/… is missing the model id");
    }
    return {
      kind: "fixed",
      transport: "native",
      userModelId: `nvidia/${model}`,
      llmModelId: `nvidia/${model}`,
      provider: "nvidia",
      openrouterProviders: null,
      forceOpenRouter: false,
      requiredEnv: "NVIDIA_API_KEY",
      // Default; can be overridden at runtime via NVIDIA_BASE_URL / config.nvidia.baseUrl.
      openaiBaseUrlOverride: "https://integrate.api.nvidia.com/v1",
      forceChatCompletions: true,
    };
  }

  if (lower.startsWith("cli/")) {
    const parts = trimmed
      .split("/")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    const providerRaw = parts[1]?.toLowerCase() ?? "";
    if (
      providerRaw !== "claude" &&
      providerRaw !== "codex" &&
      providerRaw !== "gemini" &&
      providerRaw !== "agent" &&
      providerRaw !== "openclaw" &&
      providerRaw !== "opencode"
    ) {
      throw new Error(`Invalid CLI model id "${trimmed}". Expected cli/<provider>/<model>.`);
    }
    const cliProvider = providerRaw as CliProvider;
    const requestedModel = parts.slice(2).join("/").trim();
    const cliModel = requestedModel.length > 0 ? requestedModel : DEFAULT_CLI_MODELS[cliProvider];
    const requiredEnv = requiredEnvForCliProvider(cliProvider) as Extract<
      RequiredModelEnv,
      | "CLI_CLAUDE"
      | "CLI_CODEX"
      | "CLI_GEMINI"
      | "CLI_AGENT"
      | "CLI_OPENCLAW"
      | "CLI_OPENCODE"
    >;
    const userModelId = cliModel ? `cli/${cliProvider}/${cliModel}` : `cli/${cliProvider}`;
    return {
      kind: "fixed",
      transport: "cli",
      userModelId,
      llmModelId: null,
      openrouterProviders: null,
      forceOpenRouter: false,
      requiredEnv,
      cliProvider,
      cliModel,
    };
  }

  if (lower.startsWith("openclaw/")) {
    const model = trimmed.slice("openclaw/".length).trim() || "main";
    return {
      kind: "fixed",
      transport: "cli",
      userModelId: `openclaw/${model}`,
      llmModelId: null,
      openrouterProviders: null,
      forceOpenRouter: false,
      requiredEnv: "CLI_OPENCLAW",
      cliProvider: "openclaw",
      cliModel: model,
    };
  }

  if (!trimmed.includes("/")) {
    throw new Error(
      `Unknown model "${trimmed}". Expected "auto" or a provider-prefixed id like openai/..., google/..., anthropic/..., xai/..., zai/..., openrouter/... or cli/....`,
    );
  }

  const userModelId = normalizeGatewayStyleModelId(trimmed);
  const parsed = parseGatewayStyleModelId(userModelId);
  const requiredEnv = resolveRequiredEnvForModelId(userModelId) as Extract<
    RequiredModelEnv,
    | "XAI_API_KEY"
    | "OPENAI_API_KEY"
    | "GEMINI_API_KEY"
    | "ANTHROPIC_API_KEY"
    | "Z_AI_API_KEY"
    | "NVIDIA_API_KEY"
  >;
  return {
    kind: "fixed",
    transport: "native",
    userModelId,
    llmModelId: userModelId,
    provider: parsed.provider,
    openrouterProviders: null,
    forceOpenRouter: false,
    requiredEnv,
  };
}
