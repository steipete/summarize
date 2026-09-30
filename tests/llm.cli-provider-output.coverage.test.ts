import { describe, expect, it } from "vitest";
import {
  isJsonCliProvider,
  parseCodexOutputFromJsonl,
  parseCodexUsageFromJsonl,
  parseJsonProviderOutput,
  parseOpenCodeOutputFromJsonl,
  parsePiOutputFromJsonl,
} from "../src/llm/cli-provider-output.js";

describe("CLI provider output parser coverage", () => {
  it("classifies JSON and dedicated providers", () => {
    for (const provider of [
      "codex",
      "openclaw",
      "opencode",
      "copilot",
      "agy",
      "pi",
      "devin",
    ] as const) {
      expect(isJsonCliProvider(provider)).toBe(false);
    }
    for (const provider of ["claude", "gemini", "agent"] as const) {
      expect(isJsonCliProvider(provider)).toBe(true);
    }
  });

  it("parses Codex usage aliases, inferred totals, costs, and malformed lines", () => {
    expect(parseCodexUsageFromJsonl("plain\n{bad}\n[]")).toEqual({
      usage: null,
      costUsd: null,
    });
    expect(
      parseCodexUsageFromJsonl(
        [
          JSON.stringify({
            usage: { input_tokens: 1, output_tokens: 2 },
            cost_usd: 0.1,
          }),
          JSON.stringify({
            response: { usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 10 } },
            usage: { cost_usd: 0.2 },
          }),
          JSON.stringify({
            metrics: { usage: { inputTokens: 5, outputTokens: 6, totalTokens: 20 } },
          }),
          JSON.stringify({
            usage: { input_tokens: "bad", total_tokens: Number.POSITIVE_INFINITY },
          }),
        ].join("\n"),
      ),
    ).toEqual({
      usage: { promptTokens: 5, completionTokens: 6, totalTokens: 20 },
      costUsd: 0.1,
    });
    expect(parseCodexUsageFromJsonl(JSON.stringify({ usage: { cost_usd: 0.25 } }))).toEqual({
      usage: null,
      costUsd: 0.25,
    });
  });

  it("extracts Codex deltas and every supported full-text shape", () => {
    expect(parseCodexOutputFromJsonl(" ")).toEqual({
      text: null,
      sawStructuredEvent: false,
    });
    expect(
      parseCodexOutputFromJsonl(
        [
          "plain",
          "{bad}",
          JSON.stringify({ type: "response.output_text.delta", delta: " Hel" }),
          JSON.stringify({ type: "response.output_text.delta", delta: "lo " }),
          JSON.stringify({ type: "response.output_text.done", text: "ignored full" }),
        ].join("\n"),
      ),
    ).toEqual({ text: "Hello", sawStructuredEvent: true });

    const payloads = [
      { type: "response.output_text.done", delta: "done delta" },
      { output_text: " top output " },
      { response: { output_text: " response output " } },
      {
        response: {
          output: [
            { text: "direct " },
            { content: [{ text: "nested" }, null, { nope: true }] },
            null,
          ],
        },
      },
      { message: { content: [{ text: "message" }] } },
      { item: { text: "item" } },
    ];
    const expected = [
      "done delta",
      "top output",
      "response output",
      "direct nested",
      "message",
      "item",
    ];
    for (let index = 0; index < payloads.length; index += 1) {
      expect(parseCodexOutputFromJsonl(JSON.stringify(payloads[index]))).toEqual({
        text: expected[index],
        sawStructuredEvent: true,
      });
    }
    expect(parseCodexOutputFromJsonl(JSON.stringify({ response: { output: [{}] } }))).toEqual({
      text: null,
      sawStructuredEvent: true,
    });
  });

  it("parses OpenCode text, usage, costs, errors, and fallback output", () => {
    expect(() => parseOpenCodeOutputFromJsonl(" ")).toThrow("empty output");
    expect(
      parseOpenCodeOutputFromJsonl(
        [
          JSON.stringify({ type: "text", part: { text: " Hello" } }),
          JSON.stringify({ type: "text", part: { text: " world " } }),
          JSON.stringify({ type: "text", part: null }),
          JSON.stringify({
            type: "step_finish",
            part: { tokens: { input: 2, output: 3 }, cost: 0.1 },
          }),
          JSON.stringify({
            type: "step_finish",
            part: { tokens: { input: 4, output: 5, total: 12 }, cost: 0.2 },
          }),
          JSON.stringify({ type: "step_finish", part: null }),
          "{bad}",
        ].join("\n"),
      ),
    ).toEqual({
      text: "Hello world",
      usage: { promptTokens: 6, completionTokens: 8, totalTokens: 17 },
      costUsd: 0.30000000000000004,
    });
    expect(parseOpenCodeOutputFromJsonl("plain stdout")).toEqual({
      text: "plain stdout",
      usage: null,
      costUsd: null,
    });
    expect(() => parseOpenCodeOutputFromJsonl(JSON.stringify({ type: "other" }))).toThrow(
      "empty output",
    );

    const errors = [
      { type: "error", error: " string error " },
      { type: "error", error: { data: { message: "data error" } } },
      { type: "error", error: { message: "message error" } },
      { type: "error", error: { name: "NamedError" } },
      { type: "error", error: 1 },
    ];
    expect(() => parseOpenCodeOutputFromJsonl(errors.map(JSON.stringify).join("\n"))).toThrow(
      "string error\ndata error\nmessage error\nNamedError",
    );
    expect(
      parseOpenCodeOutputFromJsonl(
        [
          JSON.stringify({ type: "error", error: "ignored because text succeeds" }),
          JSON.stringify({ type: "text", part: { text: "ok" } }),
        ].join("\n"),
      ),
    ).toEqual({ text: "ok", usage: null, costUsd: null });
  });

  it("parses Claude, Gemini, array, suffix, and plain JSON-provider output", () => {
    expect(() => parseJsonProviderOutput({ provider: "claude", stdout: " " })).toThrow(
      "empty output",
    );
    expect(
      parseJsonProviderOutput({
        provider: "claude",
        stdout: JSON.stringify({
          result: " Claude result ",
          usage: {
            input_tokens: 2,
            cache_creation_input_tokens: 3,
            cache_read_input_tokens: 4,
            output_tokens: 5,
          },
          total_cost_usd: 0.4,
        }),
      }),
    ).toEqual({
      text: "Claude result",
      usage: { promptTokens: 9, completionTokens: 5, totalTokens: 14 },
      costUsd: 0.4,
    });
    expect(
      parseJsonProviderOutput({
        provider: "claude",
        stdout: JSON.stringify({ response: "partial", usage: { output_tokens: 5 } }),
      }),
    ).toEqual({
      text: "partial",
      usage: { promptTokens: null, completionTokens: 5, totalTokens: null },
      costUsd: null,
    });
    expect(
      parseJsonProviderOutput({
        provider: "gemini",
        stdout: JSON.stringify({
          output: "Gemini result",
          stats: {
            models: {
              one: { tokens: { prompt: 2, candidates: 3 } },
              two: { tokens: { prompt: 4, candidates: 5, total: 12 } },
              empty: {},
              invalid: null,
            },
          },
        }),
      }),
    ).toEqual({
      text: "Gemini result",
      usage: { promptTokens: 6, completionTokens: 8, totalTokens: 12 },
      costUsd: null,
    });
    expect(
      parseJsonProviderOutput({
        provider: "gemini",
        stdout: JSON.stringify({ message: "No stats", stats: { models: { one: { tokens: {} } } } }),
      }),
    ).toEqual({ text: "No stats", usage: null, costUsd: null });
    expect(
      parseJsonProviderOutput({
        provider: "agent",
        stdout: JSON.stringify([{ type: "other" }, { type: "result", text: "array result" }]),
      }),
    ).toEqual({ text: "array result", usage: null, costUsd: null });
    expect(
      parseJsonProviderOutput({
        provider: "agent",
        stdout: `startup noise\n${JSON.stringify({ text: "suffix result" })}`,
      }),
    ).toEqual({ text: "suffix result", usage: null, costUsd: null });
    expect(parseJsonProviderOutput({ provider: "agent", stdout: "plain output" })).toEqual({
      text: "plain output",
      usage: null,
      costUsd: null,
    });
    expect(parseJsonProviderOutput({ provider: "agent", stdout: "{bad json" })).toEqual({
      text: "{bad json",
      usage: null,
      costUsd: null,
    });
  });

  it("covers Pi malformed content, errors, deltas, and plain fallbacks", () => {
    expect(() => parsePiOutputFromJsonl(" ")).toThrow("empty output");
    expect(
      parsePiOutputFromJsonl(
        [
          "startup line",
          "{bad}",
          JSON.stringify({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "delta" },
          }),
          JSON.stringify({
            type: "message_update",
            assistantMessageEvent: { type: "other", delta: "ignored" },
          }),
        ].join("\n"),
      ),
    ).toEqual({ text: "delta", usage: null, costUsd: null });
    expect(
      parsePiOutputFromJsonl(
        JSON.stringify({
          type: "turn_end",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: " final " },
              { type: "tool", text: "ignored" },
            ],
            usage: { input: 2, output: 3, totalTokens: 5, cost: { total: 0.01 } },
          },
        }),
      ),
    ).toEqual({
      text: "final",
      usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
      costUsd: 0.01,
    });
    expect(() =>
      parsePiOutputFromJsonl(
        [
          JSON.stringify({
            type: "message_end",
            message: { role: "user", content: [] },
          }),
          JSON.stringify({
            type: "message_end",
            message: { role: "assistant", errorMessage: " failed ", content: null },
          }),
          JSON.stringify({
            type: "turn_end",
            message: { role: "assistant", errorMessage: " failed ", content: [] },
          }),
        ].join("\n"),
      ),
    ).toThrow("failed");
    expect(() =>
      parsePiOutputFromJsonl(`${JSON.stringify({ type: "other" })}\nplain failure`),
    ).toThrow("plain failure");
    expect(() => parsePiOutputFromJsonl(JSON.stringify({ type: "other" }))).toThrow("empty output");
    expect(parsePiOutputFromJsonl("plain success")).toEqual({
      text: "plain success",
      usage: null,
      costUsd: null,
    });
  });
});
