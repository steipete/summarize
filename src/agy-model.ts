export function parseAgyModel(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f/]/u.test(value)) {
    throw new Error("Invalid Antigravity model. Use a non-empty model from `agy models`.");
  }
  return value.trim();
}
