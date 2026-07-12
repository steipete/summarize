import type {
  AgentMessage as Message,
  AgentTool as Tool,
  AgentToolCall as ToolCall,
} from "@steipete/summarize-core/runtime";
import {
  assistantMessage,
  messageText,
  parseSse,
  providerHttpError,
  safeJsonObject,
  type DirectStreamEvent,
  type ProviderStreamOptions,
} from "./shared";

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

export async function* streamOpenAiCompatible(
  options: ProviderStreamOptions,
): AsyncGenerator<DirectStreamEvent> {
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
      ...(config.provider === "minimax" ? { reasoning_split: true } : {}),
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
      const isCumulativeMiniMaxContent =
        config.provider === "minimax" && delta.content.startsWith(text);
      const visibleDelta = isCumulativeMiniMaxContent
        ? delta.content.slice(text.length)
        : delta.content;
      text = isCumulativeMiniMaxContent ? delta.content : text + delta.content;
      if (visibleDelta) yield { type: "text", text: visibleDelta };
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
