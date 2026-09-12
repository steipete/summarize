export function normalizePanelUrl(value: string) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

export function panelUrlsMatch(a: string, b: string) {
  const left = normalizePanelUrl(a);
  const right = normalizePanelUrl(b);
  if (left === right) return true;
  const boundaryMatch = (longer: string, shorter: string) => {
    if (!longer.startsWith(shorter)) return false;
    const next = longer[shorter.length];
    return next === "/" || next === "?" || next === "&";
  };
  return boundaryMatch(left, right) || boundaryMatch(right, left);
}

export function isPanelContentUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  return !(
    value.startsWith("chrome://") ||
    value.startsWith("chrome-extension://") ||
    value.startsWith("moz-extension://") ||
    value.startsWith("edge://") ||
    value.startsWith("about:")
  );
}
