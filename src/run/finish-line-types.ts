import type { MessageValues } from "@steipete/summarize-core/localization";
import type { CliMessageKey, CliMessage } from "../locale.js";

export type FinishLabel =
  | string
  | CliMessage
  | { kind: "extract"; format: "text" | "markdown"; via: string | null }
  | { kind: "summary"; words: number; sources: string[] };
export type FinishPart =
  | string
  | { kind: "length" | "detail"; key: CliMessageKey; values: MessageValues }
  | {
      kind: "compactTranscript";
      durationSeconds: number;
      approximate: boolean;
      media: "YouTube" | "podcast" | "video" | "generic";
      words: number;
    };
