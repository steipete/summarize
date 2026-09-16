import { createCliTranslator } from "../locale.js";
export const TWITTER_CLI_TIP = createCliTranslator("en")("tip.twitter");
export const BIRD_TIP = TWITTER_CLI_TIP;
export const UVX_TIP = createCliTranslator("en")("tip.uvx");
export const SUPPORT_URL = "https://github.com/steipete/summarize";
export const TWITTER_HOSTS = new Set(["x.com", "twitter.com", "mobile.twitter.com"]);
export const MAX_TEXT_BYTES_DEFAULT = 10 * 1024 * 1024;
export const MAX_PDF_EXTRACT_BYTES = 500 * 1024 * 1024; // 500 MB

export const VERBOSE_PREFIX = "[summarize]";
