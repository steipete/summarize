const THINK_BLOCK_PATTERNS = [
  /<think\b[^>]*>[\s\S]*?<\/think>/gi,
  /<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi,
];

const THINK_TAG_PATTERN = /<\/?(?:think|thinking)\b[^>]*>/gi;

const PREFIX_PLANNER_HINT = /\b(let me|i need to|task|instructions?|summary requirements|output format|hard length rule)\b/i;

const SLIDE_MARKER_PATTERN = /\[slide:\d+\]/i;
const HEADING_PATTERN = /(^|\n)#{2,6}\s+\S/m;

function firstIndex(text: string, pattern: RegExp): number {
  const match = text.match(pattern);
  if (!match || typeof match.index !== "number") return -1;
  return match.index;
}

function firstStructureIndex(text: string): number {
  const indexes = [firstIndex(text, SLIDE_MARKER_PATTERN), firstIndex(text, HEADING_PATTERN)].filter(
    (idx) => idx >= 0,
  );
  if (indexes.length === 0) return -1;
  return Math.min(...indexes);
}

export function sanitizeSummaryText(raw: string): string {
  const original = raw.trim();
  if (!original) return original;

  let sanitized = original;
  for (const pattern of THINK_BLOCK_PATTERNS) {
    sanitized = sanitized.replace(pattern, "\n");
  }
  sanitized = sanitized.replace(THINK_TAG_PATTERN, "").trim();

  const hadThinkTag = /<\s*\/?\s*(?:think|thinking)\b/i.test(original);
  const structureIndex = firstStructureIndex(sanitized);
  if (structureIndex > 0) {
    const prefix = sanitized.slice(0, structureIndex);
    if (hadThinkTag || PREFIX_PLANNER_HINT.test(prefix)) {
      sanitized = sanitized.slice(structureIndex).trimStart();
    }
  }

  return sanitized || original;
}
