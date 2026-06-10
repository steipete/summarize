import {
  buildMissingDiarizationProviderMessage,
  resolveDiarizationProviderOrder,
  type DiarizationPreference,
} from "../../../transcription/whisper.js";
import { buildMissingTranscriptionProviderNote } from "../../../transcription/whisper/provider-setup.js";
import type { TranscriptionConfig } from "../transcription-config.js";
import type { ProviderResult, TranscriptSource } from "../types.js";
import {
  resolveTranscriptionAvailability,
  type TranscriptionAvailability,
} from "./transcription-start.js";

export type TranscriptProviderCapabilities = {
  availability: TranscriptionAvailability;
  canTranscribe: boolean;
  canRunYtDlp: boolean;
  missingProviderNote: string;
};

export async function resolveTranscriptProviderCapabilities({
  transcription,
  ytDlpPath,
  diarization = null,
}: {
  transcription: TranscriptionConfig;
  ytDlpPath?: string | null;
  diarization?: DiarizationPreference | null;
}): Promise<TranscriptProviderCapabilities> {
  const availability = await resolveTranscriptionAvailability({ transcription });
  const diarizationProviders = diarization
    ? resolveDiarizationProviderOrder({
        preference: diarization,
        elevenlabsApiKey: transcription.elevenlabsApiKey,
        openaiApiKey: transcription.openaiApiKey,
      })
    : [];
  const canTranscribe = diarization ? diarizationProviders.length > 0 : availability.hasAnyProvider;
  return {
    availability,
    canTranscribe,
    canRunYtDlp: Boolean(ytDlpPath && canTranscribe),
    missingProviderNote: diarization
      ? buildMissingDiarizationProviderMessage(diarization)
      : buildMissingTranscriptionProviderNote(),
  };
}

export function buildMissingTranscriptionProviderResult(args: {
  attemptedProviders: TranscriptSource[];
  metadata: NonNullable<ProviderResult["metadata"]>;
  notes?: string[] | null;
}): ProviderResult {
  const notes = args.notes?.filter((note) => note.trim().length > 0) ?? [];
  return {
    text: null,
    source: null,
    attemptedProviders: args.attemptedProviders,
    metadata: args.metadata,
    notes: [buildMissingTranscriptionProviderNote(), ...notes].join("; "),
  };
}
