export function enableMinimaxReasoningSplit(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  return { ...payload, reasoning_split: true };
}
