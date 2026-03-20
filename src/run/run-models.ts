import type { CliProvider, ModelConfig, SummarizeConfig } from "../config.js";
import type { RequestedModel } from "../model-spec.js";
import { parseRequestedModelId } from "../model-spec.js";
import { BUILTIN_MODELS } from "./constants.js";

function resolveConfiguredCliModel(
  provider: CliProvider,
  config: SummarizeConfig | null,
): string | null {
  const cli = config?.cli;
  const raw =
    provider === "claude"
      ? cli?.claude?.model
      : provider === "codex"
      ? cli?.codex?.model
      : provider === "gemini"
        ? cli?.gemini?.model
        : provider === "agent"
          ? cli?.agent?.model
          : provider === "openclaw"
            ? cli?.openclaw?.model
          : cli?.opencode?.model;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

function resolveRequestedCliModelFromConfig(
  requestedModel: RequestedModel,
  config: SummarizeConfig | null,
): RequestedModel {
  if (requestedModel.kind !== "fixed" || requestedModel.transport !== "cli") return requestedModel;
  if (requestedModel.cliModel) return requestedModel;

  const configuredModel = resolveConfiguredCliModel(requestedModel.cliProvider, config);
  if (!configuredModel) return requestedModel;

  return {
    ...requestedModel,
    userModelId: `cli/${requestedModel.cliProvider}/${configuredModel}`,
    cliModel: configuredModel,
  };
}

export type ModelSelection = {
  requestedModel: RequestedModel;
  requestedModelInput: string;
  requestedModelLabel: string;
  isNamedModelSelection: boolean;
  isImplicitAutoSelection: boolean;
  wantsFreeNamedModel: boolean;
  configForModelSelection: SummarizeConfig | null;
  isFallbackModel: boolean;
};

export function resolveModelSelection({
  config,
  configForCli,
  configPath,
  envForRun,
  explicitModelArg,
}: {
  config: SummarizeConfig | null;
  configForCli: SummarizeConfig | null;
  configPath: string | null;
  envForRun: Record<string, string | undefined>;
  explicitModelArg: string | null;
}): ModelSelection {
  const modelMap = (() => {
    const out = new Map<string, { name: string; model: ModelConfig }>();

    for (const [name, model] of Object.entries(BUILTIN_MODELS)) {
      out.set(name.toLowerCase(), { name, model });
    }

    const raw = config?.models;
    if (!raw) return out;
    for (const [name, model] of Object.entries(raw)) {
      out.set(name.toLowerCase(), { name, model });
    }
    return out;
  })();

  const defaultModelResolution = (() => {
    if (
      typeof envForRun.SUMMARIZE_MODEL === "string" &&
      envForRun.SUMMARIZE_MODEL.trim().length > 0
    ) {
      return { value: envForRun.SUMMARIZE_MODEL.trim(), source: "env" as const };
    }
    const modelFromConfig = config?.model;
    if (modelFromConfig) {
      if ("id" in modelFromConfig && typeof modelFromConfig.id === "string") {
        const id = modelFromConfig.id.trim();
        if (id.length > 0) return { value: id, source: "config" as const };
      }
      if ("name" in modelFromConfig && typeof modelFromConfig.name === "string") {
        const name = modelFromConfig.name.trim();
        if (name.length > 0) return { value: name, source: "config" as const };
      }
      if ("mode" in modelFromConfig && modelFromConfig.mode === "auto") {
        return { value: "auto", source: "config" as const };
      }
    }
    return { value: "auto", source: "default" as const };
  })();

  const explicitModelInput = explicitModelArg?.trim() ?? "";
  const requestedModelInput = (explicitModelInput || defaultModelResolution.value).trim();
  const requestedModelSource =
    explicitModelInput.length > 0 ? ("explicit" as const) : defaultModelResolution.source;
  const requestedModelInputLower = requestedModelInput.toLowerCase();
  const wantsFreeNamedModel = requestedModelInputLower === "free";

  const namedModelMatch =
    requestedModelInputLower !== "auto" ? (modelMap.get(requestedModelInputLower) ?? null) : null;
  const namedModelConfig = namedModelMatch?.model ?? null;
  const isNamedModelSelection = Boolean(namedModelMatch);

  const configForModelSelection =
    isNamedModelSelection && namedModelConfig
      ? ({ ...(configForCli ?? {}), model: namedModelConfig } as const)
      : configForCli;

  const requestedModel: RequestedModel = (() => {
    if (isNamedModelSelection && namedModelConfig) {
      if ("id" in namedModelConfig) return parseRequestedModelId(namedModelConfig.id);
      if ("mode" in namedModelConfig && namedModelConfig.mode === "auto") return { kind: "auto" };
      throw new Error(
        `Invalid model "${namedModelMatch?.name ?? requestedModelInput}": unsupported model config`,
      );
    }

    if (requestedModelInputLower !== "auto" && !requestedModelInput.includes("/")) {
      throw new Error(
        `Unknown model "${requestedModelInput}". Define it in ${configPath ?? "~/.summarize/config.json"} under "models", or use a provider-prefixed id like openai/...`,
      );
    }

    return parseRequestedModelId(requestedModelInput);
  })();

  const requestedModelResolved = resolveRequestedCliModelFromConfig(
    requestedModel,
    configForModelSelection,
  );

  const requestedModelLabel = isNamedModelSelection
    ? requestedModelInput
    : requestedModelResolved.kind === "auto"
      ? "auto"
      : requestedModelResolved.userModelId;

  const isFallbackModel = requestedModelResolved.kind === "auto";
  const isImplicitAutoSelection =
    requestedModelResolved.kind === "auto" && requestedModelSource === "default";

  return {
    requestedModel: requestedModelResolved,
    requestedModelInput,
    requestedModelLabel,
    isNamedModelSelection,
    isImplicitAutoSelection,
    wantsFreeNamedModel,
    configForModelSelection,
    isFallbackModel,
  };
}
