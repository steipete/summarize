import { describe, expect, it } from "vitest";
import { parsePiOutputFromJsonl } from "../src/llm/cli-provider-output.js";
import { resolveCliBinary, runCliModel } from "../src/llm/cli.js";
import type { ExecFileFn } from "../src/markitdown.js";

describe("runCliModel - pi provider", () => {
  it("invokes pi in JSON print mode and passes prompts over stdin", async () => {
    const prompt = "Summarize a short local proof document.";
    let seenCmd = "";
    let seenCwd = "";
    let seenInput = "";
    const seenArgs: string[][] = [];
    const stdout = [
      JSON.stringify({
        type: "message_end",
        message: {
          role: "user",
          content: [{ type: "text", text: prompt }],
        },
      }),
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "draft text" },
      }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Final pi summary." }],
          usage: { input: 4, output: 5, totalTokens: 9, cost: { total: 0.0012 } },
        },
      }),
    ].join("\n");
    const execFileImpl: ExecFileFn = ((cmd, args, options, cb) => {
      seenCmd = String(cmd);
      seenArgs.push(args);
      seenCwd = typeof options?.cwd === "string" ? options.cwd : "";
      cb?.(null, stdout, "");
      return {
        stdin: {
          write: (chunk: unknown) => {
            seenInput += String(chunk);
          },
          end: () => {},
        },
      } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;

    const result = await runCliModel({
      provider: "pi",
      prompt,
      model: null,
      allowTools: false,
      timeoutMs: 1000,
      env: { PI_PATH: "/env/pi" },
      execFileImpl,
      config: {
        pi: {
          binary: "/configured/pi",
          model: "anthropic/claude-sonnet-4-5",
          extraArgs: ["--provider", "anthropic"],
        },
      },
      cwd: "/tmp/pi-original-cwd",
      extraArgs: ["--profile", "quiet"],
      systemPrompt: "System prompt",
    });

    expect(result).toEqual({
      text: "Final pi summary.",
      usage: { promptTokens: 4, completionTokens: 5, totalTokens: 9 },
      costUsd: 0.0012,
    });
    expect(seenCmd).toBe("/configured/pi");
    expect(seenArgs[0]?.slice(0, 4)).toEqual(["--provider", "anthropic", "--profile", "quiet"]);
    expect(seenArgs[0]).toEqual(
      expect.arrayContaining([
        "--print",
        "--mode",
        "json",
        "--no-tools",
        "--no-context-files",
        "--no-extensions",
        "--no-skills",
        "--no-session",
        "--thinking",
        "off",
        "--system-prompt",
        "System prompt",
        "--model",
        "anthropic/claude-sonnet-4-5",
      ]),
    );
    expect(seenArgs[0]).not.toContain(prompt);
    expect(seenInput).toBe(prompt);
    expect(seenCwd).toContain("summarize-pi-");
    expect(seenCwd).not.toBe("/tmp/pi-original-cwd");
  });

  it("keeps tools enabled when requested while still isolating pi context flags", async () => {
    let seenInput = "";
    let seenCwd = "";
    const seenArgs: string[][] = [];
    const execFileImpl: ExecFileFn = ((_cmd, args, options, cb) => {
      seenArgs.push(args);
      seenCwd = typeof options?.cwd === "string" ? options.cwd : "";
      cb?.(
        null,
        JSON.stringify({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "tool-enabled answer" },
        }),
        "",
      );
      return {
        stdin: {
          write: (chunk: unknown) => {
            seenInput += String(chunk);
          },
          end: () => {},
        },
      } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;

    const result = await runCliModel({
      provider: "pi",
      prompt: "Prompt from stdin",
      model: "openai/gpt-5.4",
      allowTools: true,
      timeoutMs: 1000,
      env: {},
      execFileImpl,
      config: null,
      cwd: "/tmp/pi-tools-cwd",
    });

    expect(result.text).toBe("tool-enabled answer");
    expect(seenArgs[0]).not.toContain("--no-tools");
    expect(seenArgs[0]).toEqual(
      expect.arrayContaining([
        "--print",
        "--mode",
        "json",
        "--no-context-files",
        "--no-extensions",
        "--no-skills",
        "--no-session",
        "--model",
        "openai/gpt-5.4",
      ]),
    );
    expect(seenInput).toBe("Prompt from stdin");
    expect(seenCwd).toBe("/tmp/pi-tools-cwd");
  });

  it("resolves pi binaries from PI_PATH when config binary is absent", () => {
    expect(resolveCliBinary("pi", null, { PI_PATH: "/custom/pi" })).toBe("/custom/pi");
  });
});

describe("parsePiOutputFromJsonl", () => {
  it("uses streamed text deltas when no final message text exists", () => {
    const parsed = parsePiOutputFromJsonl(
      [
        "non-json prelude",
        JSON.stringify({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "Hello " },
        }),
        JSON.stringify({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "pi" },
        }),
      ].join("\n"),
    );

    expect(parsed).toEqual({ text: "Hello pi", usage: null, costUsd: null });
  });

  it("falls back to plain stdout only when there were no structured events", () => {
    expect(parsePiOutputFromJsonl("  plain stdout  \n")).toEqual({
      text: "plain stdout",
      usage: null,
      costUsd: null,
    });
  });

  it("throws on structured pi output without assistant text", () => {
    expect(() =>
      parsePiOutputFromJsonl(
        JSON.stringify({
          type: "message_update",
          assistantMessageEvent: { type: "thinking_delta", delta: "hidden" },
        }),
      ),
    ).toThrow(/empty output/);
  });

  it("surfaces assistant error messages instead of user prompt echoes", () => {
    expect(() =>
      parsePiOutputFromJsonl(
        [
          JSON.stringify({
            type: "message_end",
            message: {
              role: "user",
              content: [{ type: "text", text: "Prompt text" }],
            },
          }),
          JSON.stringify({
            type: "message_end",
            message: {
              role: "assistant",
              content: [],
              errorMessage: "No API key for provider: anthropic",
            },
          }),
        ].join("\n"),
      ),
    ).toThrow(/No API key for provider: anthropic/);
  });

  it("surfaces plain pi startup errors after JSON session lines", () => {
    expect(() =>
      parsePiOutputFromJsonl(
        [
          JSON.stringify({ type: "session", id: "s1" }),
          "No API key found for openai.",
          "Use /login to log into a provider via OAuth or API key.",
        ].join("\n"),
      ),
    ).toThrow(/No API key found for openai/);
  });
});
