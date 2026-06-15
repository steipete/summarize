import type { AssistantMessage, Message, Tool, ToolCall } from "@earendil-works/pi-ai";
import type { DirectProvider, ProviderSettings } from "./settings";

export type DirectModelConfig = {
  provider: DirectProvider;
  model: string;
  baseUrl: string;
  apiKey: string;
};

export type DirectStreamEvent =
  | { type: "text"; text: string }
  | { type: "assistant"; assistant: AssistantMessage };

const DEFAULT_MODELS: Record<DirectProvider, string> = {
  openai: "gpt-5-mini",
  openrouter: "openai/gpt-5-mini",
  anthropic: "claude-sonnet-4-5",
  google: "gemini-3-flash",
  xai: "grok-4-fast-non-reasoning",
  zai: "glm-4.5-flash",
  nvidia: "meta/llama-3.3-70b-instruct",
  minimax: "MiniMax-M2.1",
  github: "openai/gpt-5-mini",
  ollama: "llama3.2",
};

const DEFAULT_BASE_URLS: Record<DirectProvider, string> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  anthropic: "https://api.anthropic.com",
  google: "https://generativelanguage.googleapis.com/v1beta",
  xai: "https://api.x.ai/v1",
  zai: "https://api.z.ai/api/paas/v4",
  nvidia: "https://integrate.api.nvidia.com/v1",
  minimax: "https://api.minimax.io/v1",
  github: "https://models.github.ai/inference",
  ollama: "http://localhost:11434/v1",
};

const PROVIDER_PREFIXES = new Set<DirectProvider>([
  "openai",
  "openrouter",
  "anthropic",
  "google",
  "xai",
  "zai",
  "nvidia",
  "minimax",
  "github",
  "ollama",
]);

function trimTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function providerKey(settings: ProviderSettings, provider: DirectProvider): string {
  return settings.apiKeys[provider]?.trim() ?? "";
}

function splitModelId(rawModel: string): {
  provider: DirectProvider | null;
  model: string;
} {
  const trimmed = rawModel.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0) return { provider: null, model: trimmed };
  const rawPrefix = trimmed.slice(0, slash).toLowerCase();
  if (rawPrefix === "github-copilot") {
    return { provider: "github", model: trimmed.slice(slash + 1) };
  }
  const prefix = rawPrefix as DirectProvider;
  if (!PROVIDER_PREFIXES.has(prefix)) return { provider: null, model: trimmed };
  return { provider: prefix, model: trimmed.slice(slash + 1) };
}

export function resolveDirectProviderForModel(
  rawModel: string,
  fallbackProvider: DirectProvider,
): DirectProvider {
  const parsed = splitModelId(rawModel);
  return parsed.model.toLowerCase() === "free"
    ? "openrouter"
    : (parsed.provider ?? fallbackProvider);
}

function resolveAutoProvider(settings: ProviderSettings): DirectProvider {
  const configured = settings.provider;
  if (configured === "ollama" || providerKey(settings, configured)) return configured;
  throw new Error(
    `Add an API key for ${providerLabel(configured)} in Settings > Runtime before using Auto.`,
  );
}

export function resolveDirectModel(
  rawModel: string,
  settings: ProviderSettings,
): DirectModelConfig {
  const parsed = splitModelId(rawModel);
  const requestedModel = parsed.model.toLowerCase();
  const provider = parsed.provider
    ? resolveDirectProviderForModel(rawModel, settings.provider)
    : requestedModel === "free"
      ? "openrouter"
      : resolveAutoProvider(settings);
  const model =
    !parsed.model || requestedModel === "auto" || requestedModel === "gpt-fast"
      ? DEFAULT_MODELS[provider]
      : requestedModel === "free" && provider === "openrouter"
        ? "openrouter/free"
        : parsed.model;
  const apiKey =
    provider === "ollama"
      ? providerKey(settings, provider) || "ollama"
      : providerKey(settings, provider);
  if (!apiKey) {
    throw new Error(`Add an API key for ${providerLabel(provider)} in Settings > Runtime.`);
  }
  const configuredBaseUrl = settings.baseUrls[provider]?.trim();
  return {
    provider,
    model,
    apiKey,
    baseUrl: trimTrailingSlash(configuredBaseUrl || DEFAULT_BASE_URLS[provider]),
  };
}

export function providerLabel(provider: DirectProvider): string {
  const labels: Record<DirectProvider, string> = {
    openai: "OpenAI",
    openrouter: "OpenRouter",
    anthropic: "Anthropic",
    google: "Google Gemini",
    xai: "xAI",
    zai: "Z.AI",
    nvidia: "NVIDIA",
    minimax: "MiniMax",
    github: "GitHub Models",
    ollama: "Ollama",
  };
  return labels[provider];
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistantMessage(
  config: DirectModelConfig,
  text: string,
  toolCalls: ToolCall[],
): AssistantMessage {
  return {
    role: "assistant",
    content: [...(text ? [{ type: "text" as const, text }] : []), ...toolCalls],
    timestamp: Date.now(),
    api:
      config.provider === "anthropic"
        ? "anthropic-messages"
        : config.provider === "google"
          ? "google-generative-ai"
          : "openai-completions",
    provider: config.provider,
    model: config.model,
    usage: emptyUsage(),
    stopReason: toolCalls.length > 0 ? "toolUse" : "stop",
  } as AssistantMessage;
}

function safeJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function* parseSse(response: Response): AsyncGenerator<{
  event: string;
  data: string;
}> {
  if (!response.body) throw new Error("Provider returned no response body.");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      while (true) {
        const boundary = /\r?\n\r?\n/.exec(buffer);
        if (!boundary || boundary.index == null) break;
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        let event = "message";
        const data: string[] = [];
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        }
        if (data.length > 0) yield { event, data: data.join("\n") };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function toOpenAiMessages(system: string, messages: Message[]) {
  const out: Array<Record<string, unknown>> = [{ role: "system", content: system }];
  for (const message of messages) {
    if (message.role === "user") {
      out.push({ role: "user", content: messageText(message) });
      continue;
    }
    if (message.role === "assistant") {
      const toolCalls = Array.isArray(message.content)
        ? message.content.filter((part) => part.type === "toolCall")
        : [];
      out.push({
        role: "assistant",
        content: messageText(message) || null,
        ...(toolCalls.length > 0
          ? {
              tool_calls: toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.arguments),
                },
              })),
            }
          : {}),
      });
      continue;
    }
    if (message.role === "toolResult") {
      out.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        content: messageText(message),
      });
    }
  }
  return out;
}

function toOpenAiTools(tools: Tool[]) {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

async function* streamOpenAiCompatible(options: {
  config: DirectModelConfig;
  system: string;
  messages: Message[];
  tools: Tool[];
  maxTokens: number;
  signal: AbortSignal;
  fetchImpl: typeof fetch;
}): AsyncGenerator<DirectStreamEvent> {
  const { config } = options;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    "content-type": "application/json",
  };
  if (config.provider === "openrouter") {
    headers["HTTP-Referer"] = "https://summarize.sh";
    headers["X-Title"] = "Summarize";
  }
  if (config.provider === "github") {
    headers.Accept = "application/vnd.github+json";
    headers["X-GitHub-Api-Version"] = "2026-03-10";
  }
  const response = await options.fetchImpl(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: config.model,
      messages: toOpenAiMessages(options.system, options.messages),
      stream: true,
      ...(config.provider === "openai"
        ? { max_completion_tokens: options.maxTokens }
        : { max_tokens: options.maxTokens }),
      ...(options.tools.length > 0 ? { tools: toOpenAiTools(options.tools) } : {}),
    }),
    signal: options.signal,
  });
  if (!response.ok) throw await providerHttpError(response, config);

  let text = "";
  const pendingCalls = new Map<number, { id: string; name: string; arguments: string }>();
  for await (const event of parseSse(response)) {
    if (event.data === "[DONE]") break;
    const payload = safeJsonObject(event.data);
    const choice = Array.isArray(payload.choices)
      ? (payload.choices[0] as Record<string, unknown> | undefined)
      : undefined;
    const delta =
      choice?.delta && typeof choice.delta === "object"
        ? (choice.delta as Record<string, unknown>)
        : {};
    if (typeof delta.content === "string" && delta.content) {
      text += delta.content;
      yield { type: "text", text: delta.content };
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const rawCall of delta.tool_calls) {
        if (!rawCall || typeof rawCall !== "object") continue;
        const call = rawCall as Record<string, unknown>;
        const index = typeof call.index === "number" ? call.index : 0;
        const current = pendingCalls.get(index) ?? { id: "", name: "", arguments: "" };
        if (typeof call.id === "string") current.id += call.id;
        const fn =
          call.function && typeof call.function === "object"
            ? (call.function as Record<string, unknown>)
            : {};
        if (typeof fn.name === "string") current.name += fn.name;
        if (typeof fn.arguments === "string") current.arguments += fn.arguments;
        pendingCalls.set(index, current);
      }
    }
  }
  const toolCalls = Array.from(pendingCalls.values()).map(
    (call, index) =>
      ({
        type: "toolCall",
        id: call.id || `call-${Date.now()}-${index}`,
        name: call.name,
        arguments: safeJsonObject(call.arguments),
      }) as ToolCall,
  );
  yield { type: "assistant", assistant: assistantMessage(config, text, toolCalls) };
}

function toAnthropicMessages(messages: Message[]) {
  const out: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "user") {
      out.push({ role: "user", content: messageText(message) });
      continue;
    }
    if (message.role === "assistant") {
      const content = Array.isArray(message.content)
        ? message.content.map((part) =>
            part.type === "toolCall"
              ? {
                  type: "tool_use",
                  id: part.id,
                  name: part.name,
                  input: part.arguments,
                }
              : part.type === "text"
                ? { type: "text", text: part.text }
                : { type: "text", text: "" },
          )
        : [{ type: "text", text: messageText(message) }];
      out.push({ role: "assistant", content });
      continue;
    }
    if (message.role === "toolResult") {
      out.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.toolCallId,
            content: messageText(message),
            is_error: message.isError,
          },
        ],
      });
    }
  }
  return out;
}

async function* streamAnthropic(options: {
  config: DirectModelConfig;
  system: string;
  messages: Message[];
  tools: Tool[];
  maxTokens: number;
  signal: AbortSignal;
  fetchImpl: typeof fetch;
}): AsyncGenerator<DirectStreamEvent> {
  const response = await options.fetchImpl(`${options.config.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": options.config.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: options.config.model,
      system: options.system,
      messages: toAnthropicMessages(options.messages),
      max_tokens: options.maxTokens,
      stream: true,
      ...(options.tools.length > 0
        ? {
            tools: options.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.parameters,
            })),
          }
        : {}),
    }),
    signal: options.signal,
  });
  if (!response.ok) throw await providerHttpError(response, options.config);

  let text = "";
  const pendingCalls = new Map<number, { id: string; name: string; arguments: string }>();
  for await (const event of parseSse(response)) {
    const payload = safeJsonObject(event.data);
    if (event.event === "content_block_start") {
      const index = typeof payload.index === "number" ? payload.index : 0;
      const block =
        payload.content_block && typeof payload.content_block === "object"
          ? (payload.content_block as Record<string, unknown>)
          : {};
      if (block.type === "tool_use") {
        pendingCalls.set(index, {
          id: typeof block.id === "string" ? block.id : "",
          name: typeof block.name === "string" ? block.name : "",
          arguments: "",
        });
      }
    }
    if (event.event !== "content_block_delta") continue;
    const index = typeof payload.index === "number" ? payload.index : 0;
    const delta =
      payload.delta && typeof payload.delta === "object"
        ? (payload.delta as Record<string, unknown>)
        : {};
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      text += delta.text;
      yield { type: "text", text: delta.text };
    }
    if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
      const call = pendingCalls.get(index);
      if (call) call.arguments += delta.partial_json;
    }
  }
  const toolCalls = Array.from(pendingCalls.values()).map(
    (call, index) =>
      ({
        type: "toolCall",
        id: call.id || `call-${Date.now()}-${index}`,
        name: call.name,
        arguments: safeJsonObject(call.arguments),
      }) as ToolCall,
  );
  yield {
    type: "assistant",
    assistant: assistantMessage(options.config, text, toolCalls),
  };
}

function toGoogleContents(messages: Message[]) {
  const out: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "user") {
      out.push({ role: "user", parts: [{ text: messageText(message) }] });
    } else if (message.role === "assistant") {
      const parts = Array.isArray(message.content)
        ? message.content.map((part) =>
            part.type === "toolCall"
              ? { functionCall: { name: part.name, args: part.arguments } }
              : part.type === "text"
                ? { text: part.text }
                : { text: "" },
          )
        : [{ text: messageText(message) }];
      out.push({ role: "model", parts });
    } else if (message.role === "toolResult") {
      out.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: message.toolName,
              response: {
                output: messageText(message),
                isError: message.isError,
              },
            },
          },
        ],
      });
    }
  }
  return out;
}

async function* streamGoogle(options: {
  config: DirectModelConfig;
  system: string;
  messages: Message[];
  tools: Tool[];
  maxTokens: number;
  signal: AbortSignal;
  fetchImpl: typeof fetch;
}): AsyncGenerator<DirectStreamEvent> {
  const endpoint = `${options.config.baseUrl}/models/${encodeURIComponent(
    options.config.model,
  )}:streamGenerateContent?alt=sse&key=${encodeURIComponent(options.config.apiKey)}`;
  const response = await options.fetchImpl(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: options.system }] },
      contents: toGoogleContents(options.messages),
      generationConfig: { maxOutputTokens: options.maxTokens },
      ...(options.tools.length > 0
        ? {
            tools: [
              {
                functionDeclarations: options.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                })),
              },
            ],
          }
        : {}),
    }),
    signal: options.signal,
  });
  if (!response.ok) throw await providerHttpError(response, options.config);

  let text = "";
  const toolCalls: ToolCall[] = [];
  for await (const event of parseSse(response)) {
    const payload = safeJsonObject(event.data);
    const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
    for (const rawCandidate of candidates) {
      if (!rawCandidate || typeof rawCandidate !== "object") continue;
      const candidate = rawCandidate as Record<string, unknown>;
      const content =
        candidate.content && typeof candidate.content === "object"
          ? (candidate.content as Record<string, unknown>)
          : {};
      const parts = Array.isArray(content.parts) ? content.parts : [];
      for (const rawPart of parts) {
        if (!rawPart || typeof rawPart !== "object") continue;
        const part = rawPart as Record<string, unknown>;
        if (typeof part.text === "string" && part.text) {
          text += part.text;
          yield { type: "text", text: part.text };
        }
        const fn =
          part.functionCall && typeof part.functionCall === "object"
            ? (part.functionCall as Record<string, unknown>)
            : null;
        if (fn && typeof fn.name === "string") {
          toolCalls.push({
            type: "toolCall",
            id: `call-${Date.now()}-${toolCalls.length}`,
            name: fn.name,
            arguments:
              fn.args && typeof fn.args === "object" ? (fn.args as Record<string, unknown>) : {},
          } as ToolCall);
        }
      }
    }
  }
  yield {
    type: "assistant",
    assistant: assistantMessage(options.config, text, toolCalls),
  };
}

async function providerHttpError(response: Response, config: DirectModelConfig): Promise<Error> {
  const raw = await response.text().catch(() => "");
  let detail = raw.trim();
  try {
    const parsed = JSON.parse(raw) as {
      error?: { message?: string } | string;
      message?: string;
    };
    detail =
      typeof parsed.error === "string"
        ? parsed.error
        : parsed.error?.message || parsed.message || detail;
  } catch {
    // Keep plain-text provider response.
  }
  const suffix = detail ? `: ${detail.slice(0, 600)}` : "";
  return new Error(`${providerLabel(config.provider)} API error (${response.status})${suffix}`);
}

export async function* streamDirectModel(options: {
  model: string;
  providerSettings: ProviderSettings;
  system: string;
  messages: Message[];
  tools?: Tool[];
  maxTokens?: number;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}): AsyncGenerator<DirectStreamEvent> {
  const config = resolveDirectModel(options.model, options.providerSettings);
  const shared = {
    config,
    system: options.system,
    messages: options.messages,
    tools: options.tools ?? [],
    maxTokens: options.maxTokens ?? 4096,
    signal: options.signal,
    fetchImpl: options.fetchImpl ?? globalThis.fetch.bind(globalThis),
  };
  if (config.provider === "anthropic") {
    yield* streamAnthropic(shared);
    return;
  }
  if (config.provider === "google") {
    yield* streamGoogle(shared);
    return;
  }
  yield* streamOpenAiCompatible(shared);
}

export async function completeDirectText(
  options: Omit<Parameters<typeof streamDirectModel>[0], "messages"> & {
    prompt: string;
  },
): Promise<{ text: string; assistant: AssistantMessage; config: DirectModelConfig }> {
  const config = resolveDirectModel(options.model, options.providerSettings);
  let text = "";
  let assistant: AssistantMessage | null = null;
  for await (const event of streamDirectModel({
    ...options,
    messages: [{ role: "user", content: options.prompt, timestamp: Date.now() }],
  })) {
    if (event.type === "text") text += event.text;
    else assistant = event.assistant;
  }
  if (!assistant || !text.trim()) throw new Error("Provider returned no text.");
  return { text: text.trim(), assistant, config };
}
