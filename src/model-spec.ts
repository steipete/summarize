import type { CliProvider } from "./config.js";
import { normalizeGatewayStyleModelId, parseGatewayStyleModelId } from "./llm/model-id.js";

const DEFAULT_CLI_MODELS: Record<CliProvider, string> = {
  claude: "sonnet",
  codex: "gpt-5.2",
  gemini: "gemini-3-flash-preview",
  agent: "gpt-5.2",
};
const DEFAULT_MINIMAX_MODEL = "minimax-m2.5";
const DEFAULT_MINIMAX_BASE_URL = "https://api.minimax.io/v1";
const DEFAULT_KIMI_MODEL = "kimi-k2.5";
const DEFAULT_KIMI_BASE_URL = "https://api.moonshot.ai/v1";

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
        | "MINIMAX_API_KEY"
        | "KIMI_API_KEY"
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
      requiredEnv: "CLI_CLAUDE" | "CLI_CODEX" | "CLI_GEMINI" | "CLI_AGENT";
      cliProvider: CliProvider;
      cliModel: string | null;
    };

export type RequestedModel = { kind: "auto" } | ({ kind: "fixed" } & FixedModelSpec);

export function parseRequestedModelId(raw: string): RequestedModel {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new Error("Missing model id");

  const lower = trimmed.toLowerCase();
  if (lower === "auto") return { kind: "auto" };

  if (lower === "minimax" || lower.startsWith("minimax/")) {
    const requestedModel =
      lower === "minimax" ? DEFAULT_MINIMAX_MODEL : trimmed.slice("minimax/".length).trim();
    if (requestedModel.length === 0) {
      throw new Error("Invalid model id: minimax/… is missing the model id");
    }
    const llmModelId = normalizeGatewayStyleModelId(`openai/${requestedModel}`);
    const parsed = parseGatewayStyleModelId(llmModelId);
    return {
      kind: "fixed",
      transport: "native",
      userModelId: parsed.canonical,
      llmModelId: parsed.canonical,
      provider: "openai",
      openrouterProviders: null,
      forceOpenRouter: false,
      requiredEnv: "MINIMAX_API_KEY",
      openaiBaseUrlOverride: DEFAULT_MINIMAX_BASE_URL,
      forceChatCompletions: true,
    };
  }

  if (lower === "kimi" || lower.startsWith("kimi/")) {
    const requestedModel =
      lower === "kimi" ? DEFAULT_KIMI_MODEL : trimmed.slice("kimi/".length).trim();
    if (requestedModel.length === 0) {
      throw new Error("Invalid model id: kimi/… is missing the model id");
    }
    const llmModelId = normalizeGatewayStyleModelId(`openai/${requestedModel}`);
    const parsed = parseGatewayStyleModelId(llmModelId);
    return {
      kind: "fixed",
      transport: "native",
      userModelId: parsed.canonical,
      llmModelId: parsed.canonical,
      provider: "openai",
      openrouterProviders: null,
      forceOpenRouter: false,
      requiredEnv: "KIMI_API_KEY",
      openaiBaseUrlOverride: DEFAULT_KIMI_BASE_URL,
      forceChatCompletions: true,
    };
  }

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
      providerRaw !== "agent"
    ) {
      throw new Error(`Invalid CLI model id "${trimmed}". Expected cli/<provider>/<model>.`);
    }
    const cliProvider = providerRaw as CliProvider;
    const requestedModel = parts.slice(2).join("/").trim();
    const cliModel = requestedModel.length > 0 ? requestedModel : DEFAULT_CLI_MODELS[cliProvider];
    const requiredEnv =
      cliProvider === "claude"
        ? "CLI_CLAUDE"
        : cliProvider === "codex"
          ? "CLI_CODEX"
          : cliProvider === "gemini"
            ? "CLI_GEMINI"
            : "CLI_AGENT";
    const userModelId = `cli/${cliProvider}/${cliModel}`;
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

  if (!trimmed.includes("/")) {
    throw new Error(
      `Unknown model "${trimmed}". Expected "auto", "minimax", "kimi", or a provider-prefixed id like minimax/..., kimi/..., openai/..., google/..., anthropic/..., xai/..., zai/..., openrouter/... or cli/....`,
    );
  }

  const userModelId = normalizeGatewayStyleModelId(trimmed);
  const parsed = parseGatewayStyleModelId(userModelId);
  const requiredEnv =
    parsed.provider === "xai"
      ? "XAI_API_KEY"
      : parsed.provider === "google"
        ? "GEMINI_API_KEY"
        : parsed.provider === "anthropic"
          ? "ANTHROPIC_API_KEY"
          : parsed.provider === "zai"
            ? "Z_AI_API_KEY"
            : parsed.provider === "nvidia"
              ? "NVIDIA_API_KEY"
              : "OPENAI_API_KEY";
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
