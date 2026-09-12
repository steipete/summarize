export {
  cliProviderForRequiredEnv,
  envHasRequiredKey,
  formatMissingCliModelError,
  gatewayProviderForRequiredEnv,
  isVideoUnderstandingCapableModelId,
  isVideoUnderstandingCapableProvider,
  isOpenAiCompatibleProvider,
  requiredEnvForCliProvider,
  requiredEnvForGatewayProvider,
  resolveOpenAiCompatibleClientConfigForProvider,
  resolveProviderOpenAiOverrides,
  resolveRequiredEnvForModelId,
  supportsDocumentAttachments,
  supportsStreaming,
} from "./provider-profile.js";

export type { ProviderOpenAiOverrides, ProviderRuntimeBindings } from "./provider-profile.js";

export {
  DEFAULT_AUTO_CLI_ORDER,
  DEFAULT_CLI_MODELS,
  getCliProviderProfile,
  getGatewayProviderProfile,
  isGatewayProvider,
  parseCliProviderName,
} from "./provider-registry.js";

export type {
  GatewayProvider,
  GatewayProviderProfile,
  CliProviderProfile,
  ProviderExecution,
  RequiredModelEnv,
} from "./provider-registry.js";
