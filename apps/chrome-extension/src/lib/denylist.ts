/**
 * Default domain denylist: sites with strict anti-fraud/CSP mechanisms that
 * conflict with broad content-script injection.
 *
 * Symptoms (reported in #106): ERR_BLOCKED_BY_CLIENT, 403 CDN errors, React
 * hydration failures on Facebook caused by the extension injecting into pages
 * with very strict request-blocking policies.
 */
export const DEFAULT_DENIED_HOSTS: readonly string[] = [
  "facebook.com",
  "messenger.com",
  "instagram.com",
  "accounts.google.com",
];

/**
 * Returns true when the given hostname (e.g. `www.facebook.com`) matches any
 * entry in the denylist. Matching is suffix-based so subdomains are covered:
 * `www.facebook.com` matches `facebook.com`.
 */
export function isDeniedHost(
  hostname: string,
  extra: readonly string[] = [],
): boolean {
  const host = hostname.toLowerCase();
  for (const entry of [...DEFAULT_DENIED_HOSTS, ...extra]) {
    const pattern = entry.toLowerCase();
    if (host === pattern || host.endsWith(`.${pattern}`)) return true;
  }
  return false;
}

/**
 * Returns a user-facing error message for a denied hostname that includes the
 * site name so users can distinguish this from transient extraction failures.
 */
export function deniedSiteError(hostname: string): string {
  return `Summarize is disabled on ${hostname} due to site restrictions.`;
}
