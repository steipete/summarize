import type { LocalModelRoutingConfig, ModelConfig, SummarizeConfig } from "../config.js";
import localModelRoutingDefaults from "../config/local-model-routing-defaults.json" with { type: "json" };
import type { OutputLanguage } from "../language.js";

export type LocalModelRoutingBucket = "english" | "traditionalChinese" | "bilingual" | "fallback";

type LocalModelRoutingConfigKey = keyof Required<Omit<LocalModelRoutingConfig, "enabled">>;
type LocalModelRoutingBucketConfig = Record<
  LocalModelRoutingBucket,
  {
    configKey: LocalModelRoutingConfigKey;
    defaultModel: string;
  }
>;
type RawLocalModelRoutingBucketConfig = Record<
  LocalModelRoutingBucket,
  {
    configKey: string;
    defaultModel: string;
  }
>;
type RawLocalModelRoutingDefaults = {
  buckets: RawLocalModelRoutingBucketConfig;
  retiredModelInputPatterns?: string[];
};

const LOCAL_MODEL_ROUTING_BUCKETS = [
  "english",
  "traditionalChinese",
  "bilingual",
  "fallback",
] as const satisfies readonly LocalModelRoutingBucket[];
const LOCAL_MODEL_ROUTING_CONFIG_KEYS = [
  "englishModel",
  "traditionalChineseModel",
  "bilingualModel",
  "fallbackModel",
] as const satisfies readonly LocalModelRoutingConfigKey[];

function isLocalModelRoutingConfigKey(value: string): value is LocalModelRoutingConfigKey {
  return (LOCAL_MODEL_ROUTING_CONFIG_KEYS as readonly string[]).includes(value);
}

function parseLocalModelRoutingBucketConfig(
  raw: RawLocalModelRoutingBucketConfig,
): LocalModelRoutingBucketConfig {
  const parsed = {} as LocalModelRoutingBucketConfig;

  for (const bucket of LOCAL_MODEL_ROUTING_BUCKETS) {
    const value = raw[bucket];
    if (!isLocalModelRoutingConfigKey(value.configKey)) {
      throw new Error(`Invalid local model routing defaults: ${bucket}.configKey`);
    }
    const defaultModel = value.defaultModel.trim();
    if (!defaultModel) {
      throw new Error(`Invalid local model routing defaults: ${bucket}.defaultModel`);
    }
    parsed[bucket] = {
      configKey: value.configKey,
      defaultModel,
    };
  }

  return parsed;
}

const rawLocalModelRoutingDefaults =
  localModelRoutingDefaults satisfies RawLocalModelRoutingDefaults;
const LOCAL_MODEL_ROUTING_BUCKET_CONFIG = parseLocalModelRoutingBucketConfig(
  rawLocalModelRoutingDefaults.buckets,
);
const RETIRED_LOCAL_MODEL_ROUTING_INPUT_PATTERNS = (
  rawLocalModelRoutingDefaults.retiredModelInputPatterns ?? []
).map((pattern) => new RegExp(pattern, "i"));

export const DEFAULT_LOCAL_MODEL_ROUTING_MODELS = Object.fromEntries(
  Object.values(LOCAL_MODEL_ROUTING_BUCKET_CONFIG).map(({ configKey, defaultModel }) => [
    configKey,
    defaultModel,
  ]),
) as Required<Omit<LocalModelRoutingConfig, "enabled">>;

export function getDefaultLocalModelRoutingModel(bucket: LocalModelRoutingBucket): string {
  return LOCAL_MODEL_ROUTING_BUCKET_CONFIG[bucket].defaultModel;
}

function normalizeForMatch(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll("_", "-")
    .replaceAll(/[^a-z0-9\u4e00-\u9fff+-]+/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-|-$/g, "");
}

function isBilingualLanguage(language: OutputLanguage): boolean {
  if (language.kind !== "fixed") return false;
  const values = [language.tag, language.label].map(normalizeForMatch);
  return values.some((value) => {
    if (value.includes("bilingual")) return true;
    if (value.includes("\u4e2d\u82f1") || value.includes("\u82f1\u4e2d")) return true;
    const mentionsEnglish = value.includes("english") || /\ben\b/.test(value);
    const mentionsChinese =
      value.includes("chinese") ||
      value.includes("zh") ||
      value.includes("\u4e2d\u6587") ||
      value.includes("\u6f22") ||
      value.includes("\u7e41\u9ad4");
    return mentionsEnglish && mentionsChinese;
  });
}

function isTraditionalChineseLanguage(language: OutputLanguage): boolean {
  if (language.kind !== "fixed") return false;
  const values = [language.tag, language.label].map(normalizeForMatch);
  return values.some(
    (value) =>
      value === "zh-tw" ||
      value === "zh-hant" ||
      value.includes("traditional-chinese") ||
      value.includes("chinese-traditional") ||
      value.includes("\u7e41\u4e2d") ||
      value.includes("\u7e41\u9ad4") ||
      value.includes("\u7e41\u4f53") ||
      value.includes("\u6b63\u9ad4"),
  );
}

function isEnglishLanguage(language: OutputLanguage): boolean {
  if (language.kind !== "fixed") return false;
  const tag = normalizeForMatch(language.tag);
  const label = normalizeForMatch(language.label);
  return tag === "en" || tag.startsWith("en-") || label === "english";
}

export function classifyLocalModelRoutingLanguage(
  language: OutputLanguage,
): LocalModelRoutingBucket {
  if (isBilingualLanguage(language)) return "bilingual";
  if (isTraditionalChineseLanguage(language)) return "traditionalChinese";
  if (isEnglishLanguage(language)) return "english";
  return "fallback";
}

function findNamedModel(config: SummarizeConfig | null, rawModel: string): ModelConfig | null {
  const requested = rawModel.trim().toLowerCase();
  if (!requested || requested === "auto") return null;
  for (const [name, model] of Object.entries(config?.models ?? {})) {
    if (name.trim().toLowerCase() === requested) return model;
  }
  return null;
}

function normalizeRoutedModelInput(config: SummarizeConfig | null, rawModel: string): string {
  const trimmed = rawModel.trim();
  if (findNamedModel(config, trimmed)) return trimmed;
  return trimmed.includes("/") ? trimmed : `openai/${trimmed}`;
}

function resolveActiveRoutedModelInput(
  config: SummarizeConfig | null,
  rawModel: string | null | undefined,
): string | null {
  if (!rawModel) return null;
  const modelInput = normalizeRoutedModelInput(config, rawModel);
  return RETIRED_LOCAL_MODEL_ROUTING_INPUT_PATTERNS.some((pattern) => pattern.test(modelInput))
    ? null
    : modelInput;
}

export function resolveLanguageAwareLocalModelInput({
  config,
  outputLanguage,
}: {
  config: SummarizeConfig | null;
  outputLanguage: OutputLanguage | null | undefined;
}): { modelInput: string; bucket: LocalModelRoutingBucket } | null {
  const routing = config?.localRouting;
  if (routing?.enabled !== true) return null;

  const bucket = outputLanguage
    ? classifyLocalModelRoutingLanguage(outputLanguage)
    : ("fallback" as const);
  const bucketConfig = LOCAL_MODEL_ROUTING_BUCKET_CONFIG[bucket];
  const configured = routing[bucketConfig.configKey];
  const defaultModel = bucketConfig.defaultModel;
  const defaultModelInput = normalizeRoutedModelInput(config, defaultModel);
  const configuredModelInput = resolveActiveRoutedModelInput(config, configured);
  if (configured) {
    return {
      modelInput: configuredModelInput ?? defaultModelInput,
      bucket,
    };
  }

  const fallbackModelInput = resolveActiveRoutedModelInput(config, routing.fallbackModel);
  return {
    modelInput: fallbackModelInput ?? defaultModelInput,
    bucket,
  };
}
