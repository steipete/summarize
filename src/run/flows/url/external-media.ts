export function resolveUrlFlowYtDlpPath({
  urlFetch,
  ytDlpPath,
}: {
  urlFetch?: typeof fetch;
  ytDlpPath: string | null;
}): string | null {
  // External downloaders cannot share the daemon URL guard's DNS pinning or redirect checks.
  return urlFetch ? null : ytDlpPath;
}
