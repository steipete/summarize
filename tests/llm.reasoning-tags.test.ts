import { describe, expect, it } from "vitest";
import {
  createReasoningTagFilter,
  providerStripsReasoningTags,
  stripReasoningTags,
} from "../src/llm/reasoning-tags.js";

function runFilter(deltas: string[]): string {
  const filter = createReasoningTagFilter();
  let out = "";
  for (const delta of deltas) out += filter.push(delta);
  out += filter.flush();
  return out;
}

describe("providerStripsReasoningTags", () => {
  it("enables minimax by default and leaves other providers untouched", () => {
    expect(providerStripsReasoningTags("minimax")).toBe(true);
    expect(providerStripsReasoningTags("openai")).toBe(false);
    expect(providerStripsReasoningTags("nvidia")).toBe(false);
    expect(providerStripsReasoningTags("zai")).toBe(false);
    expect(providerStripsReasoningTags("anthropic")).toBe(false);
  });
});

describe("stripReasoningTags", () => {
  it("removes a leading <think>…</think> block", () => {
    expect(stripReasoningTags("<think>reasoning here</think>\n\nFinal answer.")).toBe(
      "Final answer.",
    );
  });

  it("removes a leading block preceded by whitespace", () => {
    expect(stripReasoningTags("  \n<think>plan</think>Answer")).toBe("Answer");
  });

  it("removes a dangling </think> with no opening tag", () => {
    expect(stripReasoningTags("long reasoning trace\n</think>\nThe answer.")).toBe("The answer.");
  });

  it("passes through text with no reasoning tags unchanged", () => {
    expect(stripReasoningTags("Just a normal summary.")).toBe("Just a normal summary.");
  });

  it("does not strip content that merely mentions thinking", () => {
    expect(stripReasoningTags("I think this article is great.")).toBe(
      "I think this article is great.",
    );
  });

  it("does not strip a <think> tag that appears mid-content", () => {
    const text = "Here is code: <think>not reasoning</think> in the middle.";
    expect(stripReasoningTags(text)).toBe(text);
  });
});

describe("createReasoningTagFilter (streaming)", () => {
  it("suppresses a leading reasoning block split across deltas", () => {
    expect(runFilter(["<thi", "nk>some ", "reasoning", "</thi", "nk>", "Hello ", "world"])).toBe(
      "Hello world",
    );
  });

  it("suppresses a whole-chunk reasoning block", () => {
    expect(runFilter(["<think>reasoning</think>", "Answer text"])).toBe("Answer text");
  });

  it("passes through a stream with no reasoning block", () => {
    expect(runFilter(["Hello ", "there, ", "world"])).toBe("Hello there, world");
  });

  it("trims whitespace immediately after the closing tag only", () => {
    expect(runFilter(["<think>x</think>\n\n", "Body line 1\n", "Body line 2"])).toBe(
      "Body line 1\nBody line 2",
    );
  });

  it("drops buffered reasoning when the stream ends with no closing tag", () => {
    expect(runFilter(["<think>still thinking with no close"])).toBe("");
  });
});
