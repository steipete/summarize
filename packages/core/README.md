# @steipete/summarize-core

Core library for Summarize (content extraction + prompt builders).

- CLI package: `@steipete/summarize`
- Recommended imports (library use): `@steipete/summarize-core/content`, `@steipete/summarize-core/prompts`

The content entry point also exports DNS-pinned network helpers. `fetchWithDnsPinnedAddresses` accepts addresses attached with `attachDnsPinnedAddresses`; callers must validate those addresses first or use `createNetworkGuardedFetch` for validation. The transport honors cancellation from either a `Request` or its init options, returns null bodies for HEAD and HTTP 204/205/304, and rejects invalid HTTP responses through its promise.

The network guard revalidates every followed redirect and cancels discarded redirect bodies. Same-origin redirects retain request options and credentials; origin changes strip explicit authorization and cookie headers, including changes of scheme or port. Manual redirects remain available for the caller to consume.
