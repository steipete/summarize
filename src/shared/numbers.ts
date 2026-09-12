export function sumNumbersOrNull(values: Array<number | null>): number | null {
  let sum = 0;
  let any = false;
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      sum += value;
      any = true;
    }
  }
  return any ? sum : null;
}
