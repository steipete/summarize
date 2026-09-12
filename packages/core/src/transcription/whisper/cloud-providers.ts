import { ASSEMBLYAI_TRANSCRIPTION_MODEL_ID } from "./assemblyai.js";

export type CloudProvider = "assemblyai" | "gemini" | "openai" | "fal" | "deepgram";

type CloudProviderDescriptor = {
  provider: CloudProvider;
  label: string;
  standaloneLabel: string;
  modelId: (args: { geminiModelId: string; deepgramModelId: string }) => string;
};

type CloudProviderKeyState = {
  assemblyaiApiKey: string | null;
  geminiApiKey: string | null;
  openaiApiKey: string | null;
  falApiKey: string | null;
  deepgramApiKey: string | null;
};

type CloudProviderAvailability = {
  hasAssemblyAi: boolean;
  hasGemini: boolean;
  hasOpenai: boolean;
  hasFal: boolean;
  hasDeepgram: boolean;
};

const CLOUD_PROVIDER_DESCRIPTORS: readonly CloudProviderDescriptor[] = [
  {
    provider: "assemblyai",
    label: "AssemblyAI",
    standaloneLabel: "AssemblyAI",
    modelId: () => ASSEMBLYAI_TRANSCRIPTION_MODEL_ID,
  },
  {
    provider: "gemini",
    label: "Gemini",
    standaloneLabel: "Gemini",
    modelId: ({ geminiModelId }) => `google/${geminiModelId}`,
  },
  {
    provider: "openai",
    label: "OpenAI",
    standaloneLabel: "Whisper/OpenAI",
    modelId: () => "whisper-1",
  },
  {
    provider: "fal",
    label: "FAL",
    standaloneLabel: "Whisper/FAL",
    modelId: () => "fal-ai/wizper",
  },
  {
    provider: "deepgram",
    label: "Deepgram",
    standaloneLabel: "Deepgram",
    modelId: ({ deepgramModelId }) => `deepgram/${deepgramModelId}`,
  },
] as const;

function getCloudProviderDescriptor(provider: CloudProvider): CloudProviderDescriptor {
  const descriptor = CLOUD_PROVIDER_DESCRIPTORS.find((entry) => entry.provider === provider);
  if (!descriptor) throw new Error(`Unknown cloud provider: ${provider}`);
  return descriptor;
}

function resolveCloudProviderOrderFromAvailability(
  availability: CloudProviderAvailability,
): CloudProvider[] {
  return resolveCloudProviderOrder({
    assemblyaiApiKey: availability.hasAssemblyAi ? "1" : null,
    geminiApiKey: availability.hasGemini ? "1" : null,
    openaiApiKey: availability.hasOpenai ? "1" : null,
    falApiKey: availability.hasFal ? "1" : null,
    deepgramApiKey: availability.hasDeepgram ? "1" : null,
  });
}

export function resolveCloudProviderOrder(state: Partial<CloudProviderKeyState>): CloudProvider[] {
  const order: CloudProvider[] = [];
  if (state.assemblyaiApiKey) order.push("assemblyai");
  if (state.geminiApiKey) order.push("gemini");
  if (state.openaiApiKey) order.push("openai");
  if (state.falApiKey) order.push("fal");
  if (state.deepgramApiKey) order.push("deepgram");
  return order;
}

export function cloudProviderLabel(provider: CloudProvider, chained: boolean): string {
  const descriptor = getCloudProviderDescriptor(provider);
  return chained ? descriptor.label : descriptor.standaloneLabel;
}

export function formatCloudFallbackTargets(providers: CloudProvider[]): string {
  return providers.map((provider) => cloudProviderLabel(provider, true)).join("/");
}

export function buildCloudProviderHint(availability: CloudProviderAvailability): string | null {
  const parts = resolveCloudProviderOrderFromAvailability(availability);
  return parts.length > 0 ? parts.join("->") : null;
}

export function buildCloudModelIdChain({
  availability,
  geminiModelId,
  deepgramModelId,
}: {
  availability: CloudProviderAvailability;
  geminiModelId: string;
  deepgramModelId: string;
}): string | null {
  const parts = resolveCloudProviderOrderFromAvailability(availability).map((provider) =>
    getCloudProviderDescriptor(provider).modelId({ geminiModelId, deepgramModelId }),
  );
  return parts.length > 0 ? parts.join("->") : null;
}
