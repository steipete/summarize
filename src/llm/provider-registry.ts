export const GITHUB_MODELS_BASE_URL = "https://models.github.ai/inference";

export type ProviderExecution =
  | "simple"
  | "google"
  | "anthropic"
  | "openai-http"
  | "openai-compatible";

export type GatewayProviderProfile = {
  requiredEnv: GatewayRequiredModelEnv;
  execution: ProviderExecution;
  supportsDocuments: boolean;
  supportsStreaming: boolean;
  supportsVideoUnderstanding: boolean;
  defaultBaseUrl?: string;
  forceChatCompletions?: boolean;
};

export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434/v1";

export const DEFAULT_MINIMAX_BASE_URL = "https://api.minimax.io/v1";

export const GATEWAY_PROVIDER_PROFILES = {
  xai: {
    requiredEnv: "XAI_API_KEY",
    execution: "simple",
    supportsDocuments: false,
    supportsStreaming: true,
    supportsVideoUnderstanding: false,
  },
  openai: {
    requiredEnv: "OPENAI_API_KEY",
    execution: "openai-http",
    supportsDocuments: true,
    supportsStreaming: true,
    supportsVideoUnderstanding: false,
  },
  google: {
    requiredEnv: "GEMINI_API_KEY",
    execution: "google",
    supportsDocuments: true,
    supportsStreaming: true,
    supportsVideoUnderstanding: true,
  },
  anthropic: {
    requiredEnv: "ANTHROPIC_API_KEY",
    execution: "anthropic",
    supportsDocuments: true,
    supportsStreaming: true,
    supportsVideoUnderstanding: false,
  },
  zai: {
    requiredEnv: "Z_AI_API_KEY",
    execution: "openai-compatible",
    supportsDocuments: false,
    supportsStreaming: true,
    supportsVideoUnderstanding: false,
    defaultBaseUrl: "https://api.z.ai/api/paas/v4",
    forceChatCompletions: true,
  },
  nvidia: {
    requiredEnv: "NVIDIA_API_KEY",
    execution: "openai-compatible",
    supportsDocuments: false,
    supportsStreaming: true,
    supportsVideoUnderstanding: false,
    defaultBaseUrl: "https://integrate.api.nvidia.com/v1",
    forceChatCompletions: true,
  },
  minimax: {
    requiredEnv: "MINIMAX_API_KEY",
    execution: "openai-compatible",
    supportsDocuments: false,
    supportsStreaming: true,
    supportsVideoUnderstanding: false,
    defaultBaseUrl: DEFAULT_MINIMAX_BASE_URL,
    forceChatCompletions: true,
  },
  "github-copilot": {
    requiredEnv: "GITHUB_TOKEN",
    execution: "openai-http",
    supportsDocuments: false,
    supportsStreaming: true,
    supportsVideoUnderstanding: false,
    defaultBaseUrl: GITHUB_MODELS_BASE_URL,
    forceChatCompletions: true,
  },
  ollama: {
    requiredEnv: "OLLAMA_BASE_URL",
    execution: "openai-compatible",
    supportsDocuments: false,
    supportsStreaming: true,
    supportsVideoUnderstanding: false,
    defaultBaseUrl: DEFAULT_OLLAMA_BASE_URL,
    forceChatCompletions: true,
  },
} as const;

export type CliProviderProfile = {
  requiredEnv: CliRequiredModelEnv;
  defaultModel: string | null;
  missingBinaryLabel: string;
  installLabel: string;
  pathEnv: string;
};

export const CLI_PROVIDER_PROFILES = {
  claude: {
    requiredEnv: "CLI_CLAUDE",
    defaultModel: "sonnet",
    missingBinaryLabel: "Claude CLI",
    installLabel: "Claude CLI",
    pathEnv: "CLAUDE_PATH",
  },
  codex: {
    requiredEnv: "CLI_CODEX",
    defaultModel: null,
    missingBinaryLabel: "Codex CLI",
    installLabel: "Codex CLI",
    pathEnv: "CODEX_PATH",
  },
  gemini: {
    requiredEnv: "CLI_GEMINI",
    defaultModel: "flash",
    missingBinaryLabel: "Gemini CLI",
    installLabel: "Gemini CLI",
    pathEnv: "GEMINI_PATH",
  },
  agent: {
    requiredEnv: "CLI_AGENT",
    defaultModel: "auto",
    missingBinaryLabel: "Cursor Agent CLI",
    installLabel: "Cursor CLI",
    pathEnv: "AGENT_PATH",
  },
  openclaw: {
    requiredEnv: "CLI_OPENCLAW",
    defaultModel: "main",
    missingBinaryLabel: "OpenClaw CLI",
    installLabel: "OpenClaw CLI",
    pathEnv: "OPENCLAW_PATH",
  },
  opencode: {
    requiredEnv: "CLI_OPENCODE",
    defaultModel: null,
    missingBinaryLabel: "OpenCode CLI",
    installLabel: "OpenCode CLI",
    pathEnv: "OPENCODE_PATH",
  },
  copilot: {
    requiredEnv: "CLI_COPILOT",
    defaultModel: null,
    missingBinaryLabel: "GitHub Copilot CLI",
    installLabel: "Copilot CLI",
    pathEnv: "COPILOT_PATH",
  },
  agy: {
    requiredEnv: "CLI_AGY",
    defaultModel: null,
    missingBinaryLabel: "Antigravity CLI",
    installLabel: "agy",
    pathEnv: "AGY_PATH",
  },
  pi: {
    requiredEnv: "CLI_PI",
    defaultModel: null,
    missingBinaryLabel: "pi CLI",
    installLabel: "pi",
    pathEnv: "PI_PATH",
  },
} as const;

export type GatewayProvider = keyof typeof GATEWAY_PROVIDER_PROFILES;
export type CliProvider = keyof typeof CLI_PROVIDER_PROFILES;
export type GatewayRequiredModelEnv =
  (typeof GATEWAY_PROVIDER_PROFILES)[GatewayProvider]["requiredEnv"];
export type CliRequiredModelEnv = (typeof CLI_PROVIDER_PROFILES)[CliProvider]["requiredEnv"];
export type RequiredModelEnv = GatewayRequiredModelEnv | CliRequiredModelEnv | "OPENROUTER_API_KEY";

export const CLI_PROVIDERS = Object.keys(CLI_PROVIDER_PROFILES) as CliProvider[];

export const DEFAULT_CLI_MODELS = Object.fromEntries(
  Object.entries(CLI_PROVIDER_PROFILES).map(([provider, profile]) => [
    provider,
    profile.defaultModel,
  ]),
) as Record<CliProvider, string | null>;

export const DEFAULT_AUTO_CLI_ORDER: CliProvider[] = [
  "claude",
  "gemini",
  "codex",
  "agent",
  "openclaw",
  "opencode",
  "copilot",
  // agy is intentionally excluded from the default auto-fallback order.
  // Use --cli agy or --model cli/agy to opt in explicitly.
  // pi is also excluded; use --cli pi or --model cli/pi explicitly.
];

export function parseCliProviderName(raw: string): CliProvider | null {
  const normalized = raw.trim().toLowerCase();
  return Object.hasOwn(CLI_PROVIDER_PROFILES, normalized) ? (normalized as CliProvider) : null;
}

export function getCliProviderProfile(provider: CliProvider): CliProviderProfile {
  return CLI_PROVIDER_PROFILES[provider];
}

export function isGatewayProvider(provider: string): provider is GatewayProvider {
  return Object.hasOwn(GATEWAY_PROVIDER_PROFILES, provider);
}

export function getGatewayProviderProfile(provider: GatewayProvider): GatewayProviderProfile {
  return GATEWAY_PROVIDER_PROFILES[provider];
}
