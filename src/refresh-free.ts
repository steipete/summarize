import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import JSON5 from "json5";
import type { LlmApiKeys } from "./llm/generate-text.js";
import { generateTextWithModelId } from "./llm/generate-text.js";

type GenerateFreeOptions = {
  runs: number;
  smart: number;
  maxCandidates: number;
  concurrency: number;
  timeoutMs: number;
  minParamB: number;
  maxAgeDays: number;
  setDefault: boolean;
};

type RateLimitKind = "perMin" | "perDay";

function supportsColor(
  stream: NodeJS.WritableStream,
  env: Record<string, string | undefined>,
): boolean {
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") return true;
  if (!(stream as unknown as { isTTY?: boolean }).isTTY) return false;
  const term = env.TERM?.toLowerCase();
  if (!term || term === "dumb") return false;
  return true;
}

function ansi(code: string, input: string, enabled: boolean): string {
  if (!enabled) return input;
  return `\u001b[${code}m${input}\u001b[0m`;
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return `${ms}`;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${Math.round(ms / 100) / 10}s`;
}

function formatTokenK(value: number): string {
  if (!Number.isFinite(value)) return `${value}`;
  if (value < 1024) return `${Math.round(value)}`;
  const k = Math.round(value / 1024);
  return `${k}k`;
}

function inferParamBFromIdOrName(text: string): number | null {
  const raw = text.toLowerCase();

  // Common patterns:
  // - "...-70b-..." / "...-32b" / "...-8b-..."
  // - "...-e2b-..." (gemma-3n-e2b)
  // - "...-1.5b-..."
  const matches = raw.matchAll(/(?:^|[^a-z0-9])[a-z]?(\d+(?:\.\d+)?)b(?:[^a-z0-9]|$)/g);
  let best: number | null = null;
  for (const m of matches) {
    const numRaw = m[1];
    if (!numRaw) continue;
    const value = Number(numRaw);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (best === null || value > best) best = value;
  }
  return best;
}

function classifyOpenRouterRateLimit(message: string): RateLimitKind | null {
  const m = message.toLowerCase();
  if (!m.includes("rate limit exceeded")) return null;
  if (m.includes("per-day") || m.includes("per day") || m.includes("free-models-per-day")) {
    return "perDay";
  }
  if (m.includes("per-min") || m.includes("per min") || m.includes("free-models-per-min")) {
    return "perMin";
  }
  // Default: assume per-minute (most common for free models).
  return "perMin";
}

function assertNoComments(raw: string, path: string): void {
  let inString: '"' | "'" | null = null;
  let escaped = false;
  let line = 1;
  let col = 1;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i] ?? "";
    const next = raw[i + 1] ?? "";

    if (inString) {
      if (escaped) {
        escaped = false;
        col += 1;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        col += 1;
        continue;
      }
      if (ch === inString) {
        inString = null;
      }
      if (ch === "\n") {
        line += 1;
        col = 1;
      } else {
        col += 1;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = ch as '"' | "'";
      escaped = false;
      col += 1;
      continue;
    }

    if (ch === "/" && next === "/") {
      throw new Error(
        `Invalid config file ${path}: comments are not allowed (found // at ${line}:${col}).`,
      );
    }

    if (ch === "/" && next === "*") {
      throw new Error(
        `Invalid config file ${path}: comments are not allowed (found /* at ${line}:${col}).`,
      );
    }

    if (ch === "\n") {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
  }
}

function resolveConfigPath(env: Record<string, string | undefined>): string {
  const home = env.HOME?.trim() || homedir();
  if (!home) throw new Error("Missing HOME");
  return join(home, ".summarize", "config.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type OpenRouterModelEntry = {
  id: string;
  contextLength: number | null;
  maxCompletionTokens: number | null;
  supportedParametersCount: number;
  modality: string | null;
  inferredParamB: number | null;
  createdAtMs: number | null;
};

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = Math.max(1, Math.floor(concurrency));
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) return;
      results[current] = await fn(items[current] as T, current);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

export async function refreshFree({
  env,
  fetchImpl,
  stdout,
  stderr,
  verbose = false,
  options = {},
}: {
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  verbose?: boolean;
  options?: Partial<GenerateFreeOptions>;
}): Promise<void> {
  const color = supportsColor(stderr, env);
  const okLabel = (text: string) => ansi("1;32", text, color);
  const failLabel = (text: string) => ansi("1;31", text, color);
  const dim = (text: string) => ansi("2", text, color);
  const heading = (text: string) => ansi("1;36", text, color);
  const cmdName = heading("Refresh Free");

  const openrouterKey =
    typeof env.OPENROUTER_API_KEY === "string" && env.OPENROUTER_API_KEY.trim().length > 0
      ? env.OPENROUTER_API_KEY.trim()
      : null;
  if (!openrouterKey) {
    throw new Error("Missing OPENROUTER_API_KEY (required for refresh-free)");
  }

  const resolved: GenerateFreeOptions = {
    runs: 2,
    smart: 3,
    maxCandidates: 10,
    concurrency: 4,
    timeoutMs: 10_000,
    minParamB: 27,
    maxAgeDays: 180,
    setDefault: false,
    ...options,
  };
  const EXTRA_RUNS = Math.max(0, Math.floor(resolved.runs));
  const TOTAL_RUNS = 1 + EXTRA_RUNS;
  const SMART = Math.max(0, Math.floor(resolved.smart));
  const MAX_CANDIDATES = Math.max(1, Math.floor(resolved.maxCandidates));
  const CONCURRENCY = Math.max(1, Math.floor(resolved.concurrency));
  const TIMEOUT_MS = Math.max(1, Math.floor(resolved.timeoutMs));
  const MIN_PARAM_B = Math.max(0, Math.floor(resolved.minParamB));
  const MAX_AGE_DAYS = Math.max(0, Math.floor(resolved.maxAgeDays));
  const applyMaxAgeFilter = MAX_AGE_DAYS > 0;

  stderr.write(`${cmdName}: fetching OpenRouter models…\n`);
  const response = await fetchImpl("https://openrouter.ai/api/v1/models", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`OpenRouter /models failed: HTTP ${response.status}`);
  }
  const payload = (await response.json()) as { data?: unknown };
  const entries = (Array.isArray(payload.data) ? payload.data : []) as unknown[];

  const catalogModels: OpenRouterModelEntry[] = entries
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const obj = entry as Record<string, unknown>;
      const id = typeof obj.id === "string" ? obj.id.trim() : "";
      if (!id) return null;
      const name = typeof obj.name === "string" ? obj.name.trim() : "";

      const contextLength =
        typeof obj.context_length === "number" && Number.isFinite(obj.context_length)
          ? obj.context_length
          : null;

      const topProvider =
        obj.top_provider && typeof obj.top_provider === "object"
          ? (obj.top_provider as Record<string, unknown>)
          : null;
      const maxCompletionTokens =
        typeof topProvider?.max_completion_tokens === "number" &&
        Number.isFinite(topProvider.max_completion_tokens)
          ? (topProvider.max_completion_tokens as number)
          : null;

      const supportedParametersCount = (() => {
        const sp = obj.supported_parameters;
        if (!Array.isArray(sp)) return 0;
        return sp.filter((v) => typeof v === "string" && v.trim().length > 0).length;
      })();

      const modality = (() => {
        const arch =
          obj.architecture && typeof obj.architecture === "object"
            ? (obj.architecture as Record<string, unknown>)
            : null;
        const raw = typeof arch?.modality === "string" ? arch.modality.trim() : "";
        return raw.length > 0 ? raw : null;
      })();

      const createdAtMs = (() => {
        const created = obj.created;
        if (typeof created !== "number" || !Number.isFinite(created) || created <= 0) return null;
        // OpenRouter uses unix timestamp seconds.
        return Math.round(created * 1000);
      })();

      return {
        id,
        contextLength,
        maxCompletionTokens,
        supportedParametersCount,
        modality,
        inferredParamB: inferParamBFromIdOrName(`${id} ${name}`),
        createdAtMs,
      } satisfies OpenRouterModelEntry;
    })
    .filter((v): v is OpenRouterModelEntry => Boolean(v));

  const freeModelsAll = catalogModels.filter((m) => m.id.endsWith(":free"));
  const freeModelsAgeFiltered = freeModelsAll.filter((m) => {
    if (!applyMaxAgeFilter) return true;
    if (m.createdAtMs === null) return false;
    const ageMs = Date.now() - m.createdAtMs;
    return ageMs >= 0 && ageMs <= MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  });

  const freeModels = freeModelsAgeFiltered.filter((m) => {
    if (m.inferredParamB === null) return true;
    return m.inferredParamB >= MIN_PARAM_B;
  });
  if (freeModels.length === 0) {
    if (applyMaxAgeFilter) {
      throw new Error(
        `OpenRouter /models returned no :free models from the last ${MAX_AGE_DAYS} days`,
      );
    }
    throw new Error("OpenRouter /models returned no :free models");
  }

  const ageFilteredCount = freeModelsAll.length - freeModelsAgeFiltered.length;
  if (ageFilteredCount > 0) {
    stderr.write(
      `${cmdName}: filtered ${ageFilteredCount}/${freeModelsAll.length} old models (>${MAX_AGE_DAYS}d)\n`,
    );
    if (verbose) {
      const filteredIds = freeModelsAll
        .filter((m) => {
          if (m.createdAtMs === null) return true;
          const ageMs = Date.now() - m.createdAtMs;
          return !(ageMs >= 0 && ageMs <= MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
        })
        .map((m) => m.id)
        .sort((a, b) => a.localeCompare(b));
      for (const id of filteredIds) stderr.write(`${dim(`skip ${id}`)}\n`);
    }
  }

  const filteredCount = freeModelsAgeFiltered.length - freeModels.length;
  if (filteredCount > 0) {
    stderr.write(
      `${cmdName}: filtered ${filteredCount}/${freeModelsAgeFiltered.length} small models (<${MIN_PARAM_B}B)\n`,
    );
    if (verbose) {
      const filteredIds = freeModelsAgeFiltered
        .filter((m) => m.inferredParamB !== null && m.inferredParamB < MIN_PARAM_B)
        .map((m) => m.id)
        .sort((a, b) => a.localeCompare(b));
      for (const id of filteredIds) stderr.write(`${dim(`skip ${id}`)}\n`);
    }
  }

  const smartSorted = freeModels.slice().sort((a, b) => {
    const aCreated = a.createdAtMs ?? -1;
    const bCreated = b.createdAtMs ?? -1;
    if (aCreated !== bCreated) return bCreated - aCreated;
    const aContext = a.contextLength ?? -1;
    const bContext = b.contextLength ?? -1;
    if (aContext !== bContext) return bContext - aContext;
    const aOut = a.maxCompletionTokens ?? -1;
    const bOut = b.maxCompletionTokens ?? -1;
    if (aOut !== bOut) return bOut - aOut;
    if (a.supportedParametersCount !== b.supportedParametersCount) {
      return b.supportedParametersCount - a.supportedParametersCount;
    }
    return a.id.localeCompare(b.id);
  });

  const freeIds = smartSorted.map((m) => m.id);

  stderr.write(
    `${cmdName}: found ${freeIds.length} :free models; testing (runs=${TOTAL_RUNS}, concurrency=${CONCURRENCY}, timeout=${formatMs(TIMEOUT_MS)})…\n`,
  );

  const apiKeys: LlmApiKeys = {
    xaiApiKey: null,
    openaiApiKey: null,
    googleApiKey: null,
    anthropicApiKey: null,
    openrouterApiKey: openrouterKey,
  };

  type Ok = {
    openrouterModelId: string;
    initialLatencyMs: number;
    medianLatencyMs: number;
    totalLatencyMs: number;
    successCount: number;
    contextLength: number | null;
    maxCompletionTokens: number | null;
    supportedParametersCount: number;
    modality: string | null;
    inferredParamB: number | null;
  };
  type Result = { ok: true; value: Ok } | { ok: false; openrouterModelId: string; error: string };

  const isTty = Boolean((stderr as unknown as { isTTY?: boolean }).isTTY);
  let done = 0;
  let okCount = 0;
  const failureCounts: Record<
    | "empty"
    | "rateLimitMin"
    | "rateLimitDay"
    | "noProviders"
    | "timeout"
    | "providerError"
    | "other",
    number
  > = {
    empty: 0,
    rateLimitMin: 0,
    rateLimitDay: 0,
    noProviders: 0,
    timeout: 0,
    providerError: 0,
    other: 0,
  };
  const startedAt = Date.now();
  let lastProgressPrint = 0;

  // Global cooldown gate for OpenRouter free-model per-minute limits.
  let cooldownUntilMs = 0;
  let cooldownNotifiedAtMs = 0;
  const COOLDOWN_MS = 65_000;

  const progress = (label: string) => {
    const now = Date.now();
    const everyMs = isTty ? 150 : 1500;
    if (now - lastProgressPrint < everyMs) return;
    lastProgressPrint = now;
    const elapsedSec = Math.round((now - startedAt) / 100) / 10;
    const line = `Refresh Free: ${label} ${done}/${freeIds.length}, ok=${okCount} (elapsed ${elapsedSec}s)…`;
    if (isTty) {
      stderr.write(`\x1b[2K\r${line}`);
    } else {
      stderr.write(`${line}\n`);
    }
  };

  const note = (line: string) => {
    if (isTty) {
      // Clear current progress line, print note, then progress will redraw on next tick.
      stderr.write(`\x1b[2K\r${line}\n`);
      lastProgressPrint = 0;
      return;
    }
    stderr.write(`${line}\n`);
  };

  const results: Result[] = [];
  const idToMeta = new Map(smartSorted.map((m) => [m.id, m] as const));

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  const waitForCooldown = async () => {
    const now = Date.now();
    if (cooldownUntilMs <= now) return;
    const remaining = cooldownUntilMs - now;
    if (now - cooldownNotifiedAtMs > 5_000) {
      cooldownNotifiedAtMs = now;
      note(`${dim(`rate limit hit; sleeping ${formatMs(remaining)}…`)}`);
    }
    await sleep(remaining);
  };

  const setCooldown = (ms: number) => {
    const next = Date.now() + ms;
    if (next > cooldownUntilMs) cooldownUntilMs = next;
  };

  const classifyFailure = (message: string) => {
    const m = message.toLowerCase();
    if (m.includes("empty summary")) return "empty";
    const rl = classifyOpenRouterRateLimit(message);
    if (rl === "perMin") return "rateLimitMin";
    if (rl === "perDay") return "rateLimitDay";
    if (m.includes("no allowed providers are available")) return "noProviders";
    if (m.includes("timed out") || m.includes("timeout") || m.includes("aborted")) return "timeout";
    if (m.includes("provider returned error") || m.includes("provider error"))
      return "providerError";
    return "other";
  };

  // Pass 1: test all free models once.
  {
    const batchResults = await mapWithConcurrency(
      freeIds,
      CONCURRENCY,
      async (openrouterModelId) => {
        const runStartedAt = Date.now();
        try {
          await waitForCooldown();
          await generateTextWithModelId({
            modelId: `openai/${openrouterModelId}`,
            apiKeys,
            prompt: { userText: "Reply with a single word: OK" },
            temperature: 0,
            maxOutputTokens: 16,
            timeoutMs: TIMEOUT_MS,
            fetchImpl,
            forceOpenRouter: true,
            retries: 0,
          });

          const latencyMs = Date.now() - runStartedAt;
          done += 1;
          okCount += 1;
          progress("tested");

          const meta = idToMeta.get(openrouterModelId) ?? null;
          note(`${okLabel("ok")} ${openrouterModelId} ${dim(`(${formatMs(latencyMs)})`)}`);
          return {
            ok: true,
            value: {
              openrouterModelId,
              initialLatencyMs: latencyMs,
              medianLatencyMs: latencyMs,
              totalLatencyMs: latencyMs,
              successCount: 1,
              contextLength: meta?.contextLength ?? null,
              maxCompletionTokens: meta?.maxCompletionTokens ?? null,
              supportedParametersCount: meta?.supportedParametersCount ?? 0,
              modality: meta?.modality ?? null,
              inferredParamB: meta?.inferredParamB ?? null,
            },
          } satisfies Result;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const kind = classifyFailure(message);
          failureCounts[kind] += 1;
          if (kind === "rateLimitMin") {
            // Back off globally and retry once.
            setCooldown(COOLDOWN_MS);
            await waitForCooldown();
            try {
              const retryStartedAt = Date.now();
              await generateTextWithModelId({
                modelId: `openai/${openrouterModelId}`,
                apiKeys,
                prompt: { userText: "Reply with a single word: OK" },
                temperature: 0,
                maxOutputTokens: 16,
                timeoutMs: TIMEOUT_MS,
                fetchImpl,
                forceOpenRouter: true,
                retries: 0,
              });
              const retryLatencyMs = Date.now() - retryStartedAt;
              done += 1;
              okCount += 1;
              progress("tested");
              const meta = idToMeta.get(openrouterModelId) ?? null;
              note(`${okLabel("ok")} ${openrouterModelId} ${dim(`(${formatMs(retryLatencyMs)})`)}`);
              return {
                ok: true,
                value: {
                  openrouterModelId,
                  initialLatencyMs: retryLatencyMs,
                  medianLatencyMs: retryLatencyMs,
                  totalLatencyMs: retryLatencyMs,
                  successCount: 1,
                  contextLength: meta?.contextLength ?? null,
                  maxCompletionTokens: meta?.maxCompletionTokens ?? null,
                  supportedParametersCount: meta?.supportedParametersCount ?? 0,
                  modality: meta?.modality ?? null,
                  inferredParamB: meta?.inferredParamB ?? null,
                },
              } satisfies Result;
            } catch {
              // fall through to failure handling below
            }
          }
          done += 1;
          progress("tested");
          if (verbose) {
            note(`${failLabel("fail")} ${openrouterModelId} ${dim(`(${kind})`)}: ${message}`);
          }
          return { ok: false, openrouterModelId, error: message } satisfies Result;
        }
      },
    );

    for (const r of batchResults) results.push(r);
  }

  if (isTty) stderr.write("\n");

  const ok = results
    .filter((r): r is Extract<Result, { ok: true }> => r.ok)
    .map((r) => r.value)
    .sort((a, b) => a.medianLatencyMs - b.medianLatencyMs);

  if (ok.length === 0) {
    throw new Error(`No working :free models found (tested ${results.length})`);
  }

  {
    const failed = results.length - ok.length;
    const parts = [
      `ok=${ok.length}`,
      `failed=${failed}`,
      ...Object.entries(failureCounts)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `${k}=${v}`),
    ];
    stderr.write(`${cmdName}: results ${parts.join(" ")}\n`);
    if (failureCounts.rateLimitMin > 0) {
      stderr.write(
        `${dim("Note: OpenRouter free-model rate limits were hit; retrying later may find more working models.")}\n`,
      );
    }
    if (failureCounts.rateLimitDay > 0) {
      stderr.write(`${dim("Note: OpenRouter per-day free-model quota was hit.")}\n`);
    }
  }

  const buildSelection = (working: Ok[]) => {
    const smartFirst = working.slice().sort((a, b) => {
      const aContext = a.contextLength ?? -1;
      const bContext = b.contextLength ?? -1;
      if (aContext !== bContext) return bContext - aContext;
      const aOut = a.maxCompletionTokens ?? -1;
      const bOut = b.maxCompletionTokens ?? -1;
      if (aOut !== bOut) return bOut - aOut;
      if (a.supportedParametersCount !== b.supportedParametersCount) {
        return b.supportedParametersCount - a.supportedParametersCount;
      }
      if (a.successCount !== b.successCount) return b.successCount - a.successCount;
      if (a.medianLatencyMs !== b.medianLatencyMs) return a.medianLatencyMs - b.medianLatencyMs;
      return a.openrouterModelId.localeCompare(b.openrouterModelId);
    });

    const fastFirst = working.slice().sort((a, b) => {
      if (a.successCount !== b.successCount) return b.successCount - a.successCount;
      if (a.medianLatencyMs !== b.medianLatencyMs) return a.medianLatencyMs - b.medianLatencyMs;
      return a.openrouterModelId.localeCompare(b.openrouterModelId);
    });

    const picked = new Set<string>();
    const ordered: string[] = [];

    for (const m of smartFirst) {
      if (ordered.length >= Math.min(SMART, MAX_CANDIDATES)) break;
      if (picked.has(m.openrouterModelId)) continue;
      picked.add(m.openrouterModelId);
      ordered.push(m.openrouterModelId);
    }
    for (const m of fastFirst) {
      if (ordered.length >= MAX_CANDIDATES) break;
      if (picked.has(m.openrouterModelId)) continue;
      picked.add(m.openrouterModelId);
      ordered.push(m.openrouterModelId);
    }

    return ordered;
  };

  const selectedIdsInitial = buildSelection(ok);

  // Pass 2: refine timing for selected candidates only (RUNS total)
  const refined = ok.slice();
  if (EXTRA_RUNS > 0 && selectedIdsInitial.length > 0) {
    stderr.write(
      `${cmdName}: refining ${selectedIdsInitial.length} candidates (extra runs=${EXTRA_RUNS})…\n`,
    );
    const byId = new Map(refined.map((m) => [m.openrouterModelId, m] as const));
    for (const openrouterModelId of selectedIdsInitial) {
      const entry = byId.get(openrouterModelId);
      if (!entry) continue;
      const latencies = [entry.initialLatencyMs];
      let successCountForModel = entry.successCount;
      let lastError: unknown = null;

      for (let run = 0; run < EXTRA_RUNS; run += 1) {
        const runStartedAt = Date.now();
        try {
          await generateTextWithModelId({
            modelId: `openai/${openrouterModelId}`,
            apiKeys,
            prompt: { userText: "Reply with a single word: OK" },
            temperature: 0,
            maxOutputTokens: 16,
            timeoutMs: TIMEOUT_MS,
            fetchImpl,
            forceOpenRouter: true,
            retries: 0,
          });
          successCountForModel += 1;
          const latencyMs = Date.now() - runStartedAt;
          entry.totalLatencyMs += latencyMs;
          latencies.push(latencyMs);
        } catch (error) {
          lastError = error;
        }
      }

      if (successCountForModel === 0 && lastError) {
        if (verbose) stderr.write(`fail refine ${openrouterModelId}: ${String(lastError)}\n`);
        continue;
      }

      latencies.sort((a, b) => a - b);
      entry.medianLatencyMs = latencies[Math.floor(latencies.length / 2)] ?? entry.medianLatencyMs;
      entry.successCount = successCountForModel;
    }
  }

  const selectedIds = buildSelection(refined);

  const selected =
    selectedIds.length > 0
      ? selectedIds.map((id) => `openrouter/${id}`)
      : refined.slice(0, MAX_CANDIDATES).map((r) => `openrouter/${r.openrouterModelId}`);
  stderr.write(`${cmdName}: selected ${selected.length} candidates.\n`);

  const configPath = resolveConfigPath(env);
  let root: Record<string, unknown> = {};
  try {
    const raw = await readFile(configPath, "utf8");
    assertNoComments(raw, configPath);
    const parsed = JSON5.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      throw new Error(`Invalid config file ${configPath}: expected an object at the top level`);
    }
    root = parsed;
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code !== "ENOENT") throw error;
  }

  const configModelsRaw = root.models;
  const configModels = (() => {
    if (typeof configModelsRaw === "undefined") return {};
    if (!isRecord(configModelsRaw)) {
      throw new Error(`Invalid config file ${configPath}: "models" must be an object.`);
    }
    return { ...configModelsRaw };
  })();

  configModels.free = { rules: [{ candidates: selected }] };
  root.models = configModels;
  if (resolved.setDefault) {
    root.model = "free";
  }

  const configDir = dirname(configPath);
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await chmod(configDir, 0o700).catch(() => {});
  const next = `${JSON.stringify(root, null, 2)}\n`;
  const tmp = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, next, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, configPath);
  await chmod(configPath, 0o600).catch(() => {});

  stdout.write(`Wrote ${configPath} (models.free)\n`);

  const refinedById = new Map(refined.map((m) => [m.openrouterModelId, m] as const));
  stderr.write(`\n${heading("Selected")} (sorted, Δ latency)\n`);
  for (const modelId of selectedIds) {
    const r = refinedById.get(modelId);
    if (!r) continue;
    const avg = r.successCount > 0 ? r.totalLatencyMs / r.successCount : r.medianLatencyMs;
    const ctx = typeof r.contextLength === "number" ? `ctx=${formatTokenK(r.contextLength)}` : null;
    const out =
      typeof r.maxCompletionTokens === "number"
        ? `out=${formatTokenK(r.maxCompletionTokens)}`
        : null;
    const modality = r.modality ? r.modality : null;
    const params = typeof r.inferredParamB === "number" ? `~${r.inferredParamB}B` : null;
    const meta = [params, ctx, out, modality].filter(Boolean).join(" ");
    stderr.write(`- ${modelId} ${dim(`Δ ${formatMs(avg)} (n=${r.successCount})`)} ${dim(meta)}\n`);
  }
}
