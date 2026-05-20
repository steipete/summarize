import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createProgressGate } from "../src/run/progress.js";
import { createStreamOutputGate } from "../src/run/stream-output.js";

function collectChunks() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { stream, chunks };
}

describe("createStreamOutputGate", () => {
  it("rewrites TTY delta output when cumulative chunks correct earlier text", () => {
    const stdout = collectChunks();
    const restore = vi.fn();
    const gate = createStreamOutputGate({
      stdout: stdout.stream,
      clearProgressForStdout: vi.fn(),
      restoreProgressAfterStdout: restore,
      outputMode: "delta",
      richTty: false,
      rewriteOnReplacement: true,
      restoreDuringStream: false,
    });

    gate.handleChunk("Hello world.", "");
    gate.handleChunk("Hello world!", "Hello world.");
    gate.finalize("Hello world!");

    expect(stdout.chunks).toEqual(["Hello world.", "\r\u001b[2KHello world!", "\n"]);
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it("preserves a paused progress restore while streaming delta chunks", () => {
    const stdout = collectChunks();
    const restore = vi.fn();
    const progress = createProgressGate();
    progress.setClearProgressBeforeStdout(() => restore);
    const gate = createStreamOutputGate({
      stdout: stdout.stream,
      clearProgressForStdout: progress.clearProgressForStdout,
      restoreProgressAfterStdout: null,
      outputMode: "delta",
      richTty: false,
      rewriteOnReplacement: false,
      restoreDuringStream: false,
    });

    gate.handleChunk("Hello", "");
    gate.handleChunk("Hello world", "Hello");
    gate.finalize("Hello world");
    progress.restoreProgressAfterStdout();

    expect(stdout.chunks).toEqual(["Hello", " world", "\n"]);
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it("rewinds all printed lines before replaying a cumulative correction", () => {
    const stdout = collectChunks();
    const gate = createStreamOutputGate({
      stdout: stdout.stream,
      clearProgressForStdout: vi.fn(),
      restoreProgressAfterStdout: null,
      outputMode: "delta",
      richTty: false,
      rewriteOnReplacement: true,
      restoreDuringStream: false,
    });

    gate.handleChunk("A\nB.", "");
    gate.handleChunk("A\nB!", "A\nB.");
    gate.finalize("A\nB!");

    expect(stdout.chunks).toEqual(["A\nB.", "\r\u001b[2K\u001b[1A\r\u001b[2KA\nB!", "\n"]);
  });

  it("rewinds soft-wrapped lines before replaying a cumulative correction", () => {
    const stdout = collectChunks();
    (stdout.stream as unknown as { columns: number }).columns = 4;
    const gate = createStreamOutputGate({
      stdout: stdout.stream,
      clearProgressForStdout: vi.fn(),
      restoreProgressAfterStdout: null,
      outputMode: "delta",
      richTty: false,
      rewriteOnReplacement: true,
      restoreDuringStream: false,
    });

    gate.handleChunk("abcde.", "");
    gate.handleChunk("abcde!", "abcde.");
    gate.finalize("abcde!");

    expect(stdout.chunks).toEqual(["abcde.", "\r\u001b[2K\u001b[1A\r\u001b[2Kabcde!", "\n"]);
  });

  it("counts wide display cells when rewinding wrapped corrections", () => {
    const stdout = collectChunks();
    (stdout.stream as unknown as { columns: number }).columns = 4;
    const gate = createStreamOutputGate({
      stdout: stdout.stream,
      clearProgressForStdout: vi.fn(),
      restoreProgressAfterStdout: null,
      outputMode: "delta",
      richTty: false,
      rewriteOnReplacement: true,
      restoreDuringStream: false,
    });

    gate.handleChunk("あい.", "");
    gate.handleChunk("あい!", "あい.");
    gate.finalize("あい!");

    expect(stdout.chunks).toEqual(["あい.", "\r\u001b[2K\u001b[1A\r\u001b[2Kあい!", "\n"]);
  });

  it("counts emoji grapheme clusters when rewinding wrapped corrections", () => {
    const stdout = collectChunks();
    (stdout.stream as unknown as { columns: number }).columns = 3;
    const gate = createStreamOutputGate({
      stdout: stdout.stream,
      clearProgressForStdout: vi.fn(),
      restoreProgressAfterStdout: null,
      outputMode: "delta",
      richTty: false,
      rewriteOnReplacement: true,
      restoreDuringStream: false,
    });

    gate.handleChunk("🇺🇸.", "");
    gate.handleChunk("🇺🇸!", "🇺🇸.");
    gate.finalize("🇺🇸!");

    expect(stdout.chunks).toEqual(["🇺🇸.", "\r\u001b[2K🇺🇸!", "\n"]);
  });

  it("counts skin-tone emoji graphemes when rewinding wrapped corrections", () => {
    const stdout = collectChunks();
    (stdout.stream as unknown as { columns: number }).columns = 2;
    const gate = createStreamOutputGate({
      stdout: stdout.stream,
      clearProgressForStdout: vi.fn(),
      restoreProgressAfterStdout: null,
      outputMode: "delta",
      richTty: false,
      rewriteOnReplacement: true,
      restoreDuringStream: false,
    });

    gate.handleChunk("✌🏽.", "");
    gate.handleChunk("✌🏽!", "✌🏽.");
    gate.finalize("✌🏽!");

    expect(stdout.chunks).toEqual(["✌🏽.", "\r\u001b[2K\u001b[1A\r\u001b[2K✌🏽!", "\n"]);
  });

  it("keeps bare text-default hand symbols as single-cell rewrites", () => {
    const stdout = collectChunks();
    (stdout.stream as unknown as { columns: number }).columns = 2;
    const gate = createStreamOutputGate({
      stdout: stdout.stream,
      clearProgressForStdout: vi.fn(),
      restoreProgressAfterStdout: null,
      outputMode: "delta",
      richTty: false,
      rewriteOnReplacement: true,
      restoreDuringStream: false,
    });

    gate.handleChunk("✌.", "");
    gate.handleChunk("✌!", "✌.");
    gate.finalize("✌!");

    expect(stdout.chunks).toEqual(["✌.", "\r\u001b[2K✌!", "\n"]);
  });

  it("counts standalone skin-tone modifiers as visible rewrites", () => {
    const stdout = collectChunks();
    (stdout.stream as unknown as { columns: number }).columns = 2;
    const gate = createStreamOutputGate({
      stdout: stdout.stream,
      clearProgressForStdout: vi.fn(),
      restoreProgressAfterStdout: null,
      outputMode: "delta",
      richTty: false,
      rewriteOnReplacement: true,
      restoreDuringStream: false,
    });

    gate.handleChunk("🏽.", "");
    gate.handleChunk("🏽!", "🏽.");
    gate.finalize("🏽!");

    expect(stdout.chunks).toEqual(["🏽.", "\r\u001b[2K\u001b[1A\r\u001b[2K🏽!", "\n"]);
  });

  it("keeps text-presentation symbols as single-cell rewrites", () => {
    const stdout = collectChunks();
    (stdout.stream as unknown as { columns: number }).columns = 2;
    const gate = createStreamOutputGate({
      stdout: stdout.stream,
      clearProgressForStdout: vi.fn(),
      restoreProgressAfterStdout: null,
      outputMode: "delta",
      richTty: false,
      rewriteOnReplacement: true,
      restoreDuringStream: false,
    });

    gate.handleChunk("✓.", "");
    gate.handleChunk("✓!", "✓.");
    gate.finalize("✓!");

    expect(stdout.chunks).toEqual(["✓.", "\r\u001b[2K✓!", "\n"]);
  });

  it("keeps lone regional indicators as single-cell rewrites", () => {
    const stdout = collectChunks();
    (stdout.stream as unknown as { columns: number }).columns = 2;
    const gate = createStreamOutputGate({
      stdout: stdout.stream,
      clearProgressForStdout: vi.fn(),
      restoreProgressAfterStdout: null,
      outputMode: "delta",
      richTty: false,
      rewriteOnReplacement: true,
      restoreDuringStream: false,
    });

    gate.handleChunk("🇺.", "");
    gate.handleChunk("🇺!", "🇺.");
    gate.finalize("🇺!");

    expect(stdout.chunks).toEqual(["🇺.", "\r\u001b[2K🇺!", "\n"]);
  });

  it("preserves halfwidth spacing mark width in grapheme rewrites", () => {
    const stdout = collectChunks();
    (stdout.stream as unknown as { columns: number }).columns = 2;
    const gate = createStreamOutputGate({
      stdout: stdout.stream,
      clearProgressForStdout: vi.fn(),
      restoreProgressAfterStdout: null,
      outputMode: "delta",
      richTty: false,
      rewriteOnReplacement: true,
      restoreDuringStream: false,
    });

    gate.handleChunk("ｶﾞ.", "");
    gate.handleChunk("ｶﾞ!", "ｶﾞ.");
    gate.finalize("ｶﾞ!");

    expect(stdout.chunks).toEqual(["ｶﾞ.", "\r\u001b[2K\u001b[1A\r\u001b[2Kｶﾞ!", "\n"]);
  });

  it("suppresses unsafe rewrites after output has scrolled beyond the viewport", () => {
    const stdout = collectChunks();
    const stream = stdout.stream as unknown as { columns: number; rows: number };
    stream.columns = 80;
    stream.rows = 1;
    const gate = createStreamOutputGate({
      stdout: stdout.stream,
      clearProgressForStdout: vi.fn(),
      restoreProgressAfterStdout: null,
      outputMode: "delta",
      richTty: false,
      rewriteOnReplacement: true,
      restoreDuringStream: false,
    });

    gate.handleChunk("A\nB.", "");
    gate.handleChunk("A\nB!", "A\nB.");
    gate.finalize("A\nB!");

    expect(stdout.chunks).toEqual(["A\nB.", "\nA\nB!\n"]);
  });
});
