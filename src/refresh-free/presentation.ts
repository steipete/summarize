import { ansi, isRichTty } from "../run/terminal.js";
import type {
  BenchmarkedOpenRouterModel,
  BenchmarkFailureCounts,
  BenchmarkFailureKind,
} from "./benchmark.js";

function supportsColor(
  stream: NodeJS.WritableStream,
  env: Record<string, string | undefined>,
): boolean {
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") return true;
  if (!isRichTty(stream)) return false;
  const term = env.TERM?.toLowerCase();
  return Boolean(term && term !== "dumb");
}

export function formatRefreshFreeDuration(ms: number): string {
  if (!Number.isFinite(ms)) return `${ms}`;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${Math.round(ms / 100) / 10}s`;
}

function formatTokenK(value: number): string {
  if (!Number.isFinite(value)) return `${value}`;
  if (value < 1024) return `${Math.round(value)}`;
  return `${Math.round(value / 1024)}k`;
}

export class RefreshFreeReporter {
  readonly #stderr: NodeJS.WritableStream;
  readonly #verbose: boolean;
  readonly #color: boolean;
  readonly #isTty: boolean;
  #lastProgressPrint = 0;

  constructor({
    stderr,
    env,
    verbose,
  }: {
    stderr: NodeJS.WritableStream;
    env: Record<string, string | undefined>;
    verbose: boolean;
  }) {
    this.#stderr = stderr;
    this.#verbose = verbose;
    this.#color = supportsColor(stderr, env);
    this.#isTty = isRichTty(stderr);
  }

  #ansi(code: string, text: string) {
    return ansi(code, text, this.#color);
  }

  #dim(text: string) {
    return this.#ansi("2", text);
  }

  #commandName() {
    return this.#ansi("1;36", "Refresh Free");
  }

  #note(line: string) {
    if (this.#isTty) {
      this.#stderr.write(`\x1b[2K\r${line}\n`);
      this.#lastProgressPrint = 0;
      return;
    }
    this.#stderr.write(`${line}\n`);
  }

  fetchingCatalog() {
    this.#stderr.write(`${this.#commandName()}: fetching OpenRouter models…\n`);
  }

  filteredOldModels({
    count,
    total,
    maxAgeDays,
    ids,
  }: {
    count: number;
    total: number;
    maxAgeDays: number;
    ids: string[];
  }) {
    if (count <= 0) return;
    this.#stderr.write(
      `${this.#commandName()}: filtered ${count}/${total} old models (>${maxAgeDays}d)\n`,
    );
    if (this.#verbose) {
      for (const id of ids) this.#stderr.write(`${this.#dim(`skip ${id}`)}\n`);
    }
  }

  filteredSmallModels({
    count,
    total,
    minParamB,
    ids,
  }: {
    count: number;
    total: number;
    minParamB: number;
    ids: string[];
  }) {
    if (count <= 0) return;
    this.#stderr.write(
      `${this.#commandName()}: filtered ${count}/${total} small models (<${minParamB}B)\n`,
    );
    if (this.#verbose) {
      for (const id of ids) this.#stderr.write(`${this.#dim(`skip ${id}`)}\n`);
    }
  }

  benchmarkStarting({
    modelCount,
    totalRuns,
    concurrency,
    timeoutMs,
  }: {
    modelCount: number;
    totalRuns: number;
    concurrency: number;
    timeoutMs: number;
  }) {
    this.#stderr.write(
      `${this.#commandName()}: found ${modelCount} :free models; testing (runs=${totalRuns}, concurrency=${concurrency}, timeout=${formatRefreshFreeDuration(timeoutMs)})…\n`,
    );
  }

  benchmarkProgress({
    done,
    total,
    okCount,
    elapsedMs,
  }: {
    done: number;
    total: number;
    okCount: number;
    elapsedMs: number;
  }) {
    const now = Date.now();
    const everyMs = this.#isTty ? 150 : 1500;
    if (now - this.#lastProgressPrint < everyMs) return;
    this.#lastProgressPrint = now;
    const elapsedSec = Math.round(elapsedMs / 100) / 10;
    const line = `Refresh Free: tested ${done}/${total}, ok=${okCount} (elapsed ${elapsedSec}s)…`;
    if (this.#isTty) {
      this.#stderr.write(`\x1b[2K\r${line}`);
    } else {
      this.#stderr.write(`${line}\n`);
    }
  }

  benchmarkSuccess({ modelId, latencyMs }: { modelId: string; latencyMs: number }) {
    this.#note(
      `${this.#ansi("1;32", "ok")} ${modelId} ${this.#dim(`(${formatRefreshFreeDuration(latencyMs)})`)}`,
    );
  }

  benchmarkFailure({
    modelId,
    kind,
    message,
  }: {
    modelId: string;
    kind: BenchmarkFailureKind;
    message: string;
  }) {
    if (!this.#verbose) return;
    this.#note(`${this.#ansi("1;31", "fail")} ${modelId} ${this.#dim(`(${kind})`)}: ${message}`);
  }

  cooldown(remainingMs: number) {
    this.#note(
      `${this.#dim(`rate limit hit; sleeping ${formatRefreshFreeDuration(remainingMs)}…`)}`,
    );
  }

  benchmarkFinished() {
    if (this.#isTty) this.#stderr.write("\n");
  }

  benchmarkResults({
    workingCount,
    testedCount,
    failureCounts,
  }: {
    workingCount: number;
    testedCount: number;
    failureCounts: BenchmarkFailureCounts;
  }) {
    const parts = [
      `ok=${workingCount}`,
      `failed=${testedCount - workingCount}`,
      ...Object.entries(failureCounts)
        .filter(([, count]) => count > 0)
        .map(([kind, count]) => `${kind}=${count}`),
    ];
    this.#stderr.write(`${this.#commandName()}: results ${parts.join(" ")}\n`);
    if (failureCounts.rateLimitMin > 0) {
      this.#stderr.write(
        `${this.#dim("Note: OpenRouter free-model rate limits were hit; retrying later may find more working models.")}\n`,
      );
    }
    if (failureCounts.rateLimitDay > 0) {
      this.#stderr.write(`${this.#dim("Note: OpenRouter per-day free-model quota was hit.")}\n`);
    }
  }

  refining(candidateCount: number, extraRuns: number) {
    this.#stderr.write(
      `${this.#commandName()}: refining ${candidateCount} candidates (extra runs=${extraRuns})…\n`,
    );
  }

  refinementFailure(modelId: string, error: unknown) {
    if (this.#verbose) this.#stderr.write(`fail refine ${modelId}: ${String(error)}\n`);
  }

  selected(candidateCount: number) {
    this.#stderr.write(`${this.#commandName()}: selected ${candidateCount} candidates.\n`);
  }

  selectedModels(selectedIds: string[], refined: BenchmarkedOpenRouterModel[]) {
    const byId = new Map(refined.map((model) => [model.openrouterModelId, model] as const));
    this.#stderr.write(`\n${this.#ansi("1;36", "Selected")} (sorted, Δ latency)\n`);
    for (const modelId of selectedIds) {
      const result = byId.get(modelId);
      if (!result) continue;
      const average =
        result.successCount > 0
          ? result.totalLatencyMs / result.successCount
          : result.medianLatencyMs;
      const context =
        typeof result.contextLength === "number"
          ? `ctx=${formatTokenK(result.contextLength)}`
          : null;
      const output =
        typeof result.maxCompletionTokens === "number"
          ? `out=${formatTokenK(result.maxCompletionTokens)}`
          : null;
      const params =
        typeof result.inferredParamB === "number" ? `~${result.inferredParamB}B` : null;
      const metadata = [params, context, output, result.modality].filter(Boolean).join(" ");
      this.#stderr.write(
        `- ${modelId} ${this.#dim(`Δ ${formatRefreshFreeDuration(average)} (n=${result.successCount})`)} ${this.#dim(metadata)}\n`,
      );
    }
  }
}
