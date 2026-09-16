import {
  type CliLocale,
  type CliProgressCallback,
  createCliTranslator,
  resolveCliLocaleFromEnv,
} from "../locale.js";
import { ansi, isRichTty, supportsColor } from "../run/terminal.js";
import type {
  BenchmarkedOpenRouterModel,
  BenchmarkFailureCounts,
  BenchmarkFailureKind,
} from "./benchmark.js";

export function formatRefreshFreeDuration(ms: number, locale: CliLocale = "en"): string {
  if (!Number.isFinite(ms)) return `${ms}`;
  const number = new Intl.NumberFormat(locale, {
    maximumFractionDigits: ms < 1000 ? 0 : 1,
    useGrouping: false,
  });
  return ms < 1000 ? `${number.format(ms)}ms` : `${number.format(ms / 1000)}s`;
}

function formatTokenK(value: number, locale: CliLocale): string {
  if (!Number.isFinite(value)) return `${value}`;
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 0, useGrouping: false });
  return value < 1024 ? number.format(value) : `${number.format(value / 1024)}k`;
}

export class RefreshFreeReporter {
  readonly #stderr: NodeJS.WritableStream;
  readonly #verbose: boolean;
  readonly #color: boolean;
  readonly #isTty: boolean;
  readonly #locale: CliLocale;
  readonly #t: ReturnType<typeof createCliTranslator>;
  #lastProgressPrint = 0;

  constructor({
    stderr,
    env,
    verbose,
    onMessage,
  }: {
    onMessage?: CliProgressCallback;
    stderr: NodeJS.WritableStream;
    env: Record<string, string | undefined>;
    verbose: boolean;
  }) {
    this.#stderr = stderr;
    this.#verbose = verbose;
    this.#color = supportsColor(stderr, env);
    this.#isTty = isRichTty(stderr);
    this.#locale = resolveCliLocaleFromEnv(env);
    const translate = createCliTranslator(this.#locale);
    this.#t = (key, values = {}) => {
      const text = translate(key, values);
      onMessage?.(text, { key, values });
      return text;
    };
  }

  #ansi(code: string, text: string) {
    return ansi(code, text, this.#color);
  }
  #dim(text: string) {
    return this.#ansi("2", text);
  }
  #duration(ms: number) {
    return formatRefreshFreeDuration(ms, this.#locale);
  }
  #note(line: string) {
    if (this.#isTty) {
      this.#stderr.write(`\x1b[2K\r${line}\n`);
      this.#lastProgressPrint = 0;
    } else this.#stderr.write(`${line}\n`);
  }

  fetchingCatalog() {
    this.#stderr.write(`${this.#ansi("1;36", this.#t("refresh.fetching"))}\n`);
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
    this.#stderr.write(`${this.#t("refresh.filteredOld", { count, total, days: maxAgeDays })}\n`);
    if (this.#verbose)
      for (const id of ids) this.#stderr.write(`${this.#dim(this.#t("refresh.skip", { id }))}\n`);
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
    this.#stderr.write(`${this.#t("refresh.filteredSmall", { count, total, min: minParamB })}\n`);
    if (this.#verbose)
      for (const id of ids) this.#stderr.write(`${this.#dim(this.#t("refresh.skip", { id }))}\n`);
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
      `${this.#t("refresh.starting", { count: modelCount, runs: totalRuns, concurrency, timeout: this.#duration(timeoutMs) })}\n`,
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
    if (now - this.#lastProgressPrint < (this.#isTty ? 150 : 1500)) return;
    this.#lastProgressPrint = now;
    const line = this.#t("refresh.progress", {
      done,
      total,
      ok: okCount,
      elapsed: this.#duration(elapsedMs),
    });
    this.#stderr.write(this.#isTty ? `\x1b[2K\r${line}` : `${line}\n`);
  }

  benchmarkSuccess({ modelId, latencyMs }: { modelId: string; latencyMs: number }) {
    this.#note(
      this.#ansi(
        "1;32",
        this.#t("refresh.success", { model: modelId, latency: this.#duration(latencyMs) }),
      ),
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
    if (this.#verbose)
      this.#note(this.#ansi("1;31", this.#t("refresh.failure", { model: modelId, kind, message })));
  }

  cooldown(remainingMs: number) {
    this.#note(this.#dim(this.#t("refresh.cooldown", { duration: this.#duration(remainingMs) })));
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
    const failures = Object.entries(failureCounts)
      .filter(([, count]) => count > 0)
      .map(([kind, count]) => `${kind}=${new Intl.NumberFormat(this.#locale).format(count)}`)
      .join(" ");
    this.#stderr.write(
      `${this.#t("refresh.results", { ok: workingCount, failed: testedCount - workingCount, failures, hasFailures: Boolean(failures) })}\n`,
    );
    if (failureCounts.rateLimitMin > 0)
      this.#stderr.write(`${this.#dim(this.#t("refresh.minuteLimit"))}\n`);
    if (failureCounts.rateLimitDay > 0)
      this.#stderr.write(`${this.#dim(this.#t("refresh.dayLimit"))}\n`);
  }

  refining(candidateCount: number, extraRuns: number) {
    this.#stderr.write(
      `${this.#t("refresh.refining", { count: candidateCount, runs: extraRuns })}\n`,
    );
  }

  refinementFailure(modelId: string, error: unknown) {
    if (this.#verbose)
      this.#stderr.write(
        `${this.#t("refresh.refinementFailure", { model: modelId, message: String(error) })}\n`,
      );
  }

  selected(candidateCount: number) {
    this.#stderr.write(`${this.#t("refresh.selected", { count: candidateCount })}\n`);
  }

  selectedModels(selectedIds: string[], refined: BenchmarkedOpenRouterModel[]) {
    const byId = new Map(refined.map((model) => [model.openrouterModelId, model] as const));
    this.#stderr.write(`\n${this.#ansi("1;36", this.#t("refresh.selectedHeading"))}\n`);
    for (const modelId of selectedIds) {
      const result = byId.get(modelId);
      if (!result) continue;
      const average =
        result.successCount > 0
          ? result.totalLatencyMs / result.successCount
          : result.medianLatencyMs;
      const context =
        typeof result.contextLength === "number"
          ? `ctx=${formatTokenK(result.contextLength, this.#locale)}`
          : null;
      const output =
        typeof result.maxCompletionTokens === "number"
          ? `out=${formatTokenK(result.maxCompletionTokens, this.#locale)}`
          : null;
      const params =
        typeof result.inferredParamB === "number"
          ? `~${new Intl.NumberFormat(this.#locale).format(result.inferredParamB)}B`
          : null;
      const metadata = [params, context, output, result.modality].filter(Boolean).join(" ");
      this.#stderr.write(
        `${this.#t("refresh.candidate", { model: modelId, latency: this.#duration(average), count: result.successCount, metadata })}\n`,
      );
    }
  }
}
