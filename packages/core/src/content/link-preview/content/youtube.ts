import { extractInitialPlayerResponse } from "../../transcript/utils.js";
import { normalizeWhitespace } from "./cleaner.js";

export function extractYouTubeShortDescription(html: string): string | null {
  const videoDetails = extractInitialPlayerResponse(html)?.videoDetails;
  if (!videoDetails || typeof videoDetails !== "object") return null;
  const description = (videoDetails as Record<string, unknown>).shortDescription;
  if (typeof description !== "string") return null;
  return normalizeWhitespace(description) || null;
}
