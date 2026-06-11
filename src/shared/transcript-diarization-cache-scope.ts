import type { CacheState } from "../cache.js";
import type { TranscriptCache } from "../content/index.js";

type TranscriptDiarizationPreference = "auto" | "elevenlabs" | "openai";
type TranscriptDiarizationProvider = Exclude<TranscriptDiarizationPreference, "auto">;
type TranscriptDiarizationCacheScope = TranscriptDiarizationProvider | "auto";

function resolveCachedDiarizationProvider(
  metadata: Record<string, unknown> | null | undefined,
): TranscriptDiarizationProvider | null {
  const provider = metadata?.diarizationProvider;
  return provider === "elevenlabs" || provider === "openai" ? provider : null;
}

function isCachedDiarizationCompatible(
  metadata: Record<string, unknown> | null | undefined,
  preference: TranscriptDiarizationPreference | null,
): boolean {
  if (!preference) return true;
  const hasSpeakerLabels = metadata?.speakerLabels === true;
  const provider = resolveCachedDiarizationProvider(metadata);
  return hasSpeakerLabels && (preference === "auto" || provider === preference);
}

function scopeUrl(scope: TranscriptDiarizationCacheScope, url: string): string {
  return `summarize-diarize:${scope}:${url}`;
}

export function resolveTranscriptDiarizationCacheReadScopes(
  preference: TranscriptDiarizationPreference | null | undefined,
): readonly TranscriptDiarizationCacheScope[] | null {
  if (!preference) return null;
  if (preference === "auto") {
    return ["elevenlabs", "openai", "auto"];
  }
  return [preference, "auto"];
}

export function resolveTranscriptDiarizationCacheWriteScope({
  preference,
  metadata,
}: {
  preference: TranscriptDiarizationPreference | null | undefined;
  metadata: Record<string, unknown> | null | undefined;
}): TranscriptDiarizationCacheScope | null {
  if (!preference) return null;
  if (preference === "auto") {
    return resolveCachedDiarizationProvider(metadata) ?? "auto";
  }
  return preference;
}

export function scopeTranscriptCacheForDiarization(
  cache: CacheState,
  preference: TranscriptDiarizationPreference | null,
): CacheState {
  const readScopes = resolveTranscriptDiarizationCacheReadScopes(preference);
  if (!cache.store || !readScopes) return cache;

  const base = cache.store.transcriptCache;
  const transcriptCache: TranscriptCache = {
    get: async (args) => {
      let fallback: Awaited<ReturnType<TranscriptCache["get"]>> | null = null;
      for (const scope of readScopes) {
        const cached = await base.get({ ...args, url: scopeUrl(scope, args.url) });
        if (!cached) continue;
        fallback ??= cached;
        if (cached.expired) continue;
        if (!isCachedDiarizationCompatible(cached.metadata, preference)) continue;
        return cached;
      }
      return fallback;
    },
    set: async (args) => {
      const scope = resolveTranscriptDiarizationCacheWriteScope({
        preference,
        metadata: args.metadata ?? null,
      });
      return await base.set({
        ...args,
        url: scope ? scopeUrl(scope, args.url) : args.url,
      });
    },
  };

  return {
    ...cache,
    store: {
      ...cache.store,
      transcriptCache,
    },
  };
}
