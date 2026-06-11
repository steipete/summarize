# Firefox Extension Testing

## Supported smoke path

`pnpm -C apps/chrome-extension test:firefox`

This builds `.output/firefox-mv3`, finds an installed Firefox or Playwright Firefox binary, and uses Mozilla `web-ext` to install the build as a temporary add-on in headless Firefox. CI runs the same command.

Set `FIREFOX_BINARY=/path/to/firefox` when automatic discovery is unsuitable.

## Advisory lint

`pnpm -C apps/chrome-extension test:firefox:lint`

`web-ext lint` reports known warnings for Chrome-only APIs that remain in dead Firefox bundle branches and for the current minimum-version metadata. Treat this as advisory until the browser-specific bundles remove those symbols.

## Playwright diagnostics

`pnpm -C apps/chrome-extension test:firefox:force`

Playwright still cannot reliably load and navigate temporary Firefox extensions. The forced project remains available for upstream diagnostics, but it is not the supported Firefox gate.

Known limitations:

- no Firefox extension service-worker events
- unreliable `--load-extension` behavior
- `moz-extension://` navigation can fail with `NS_ERROR_NOT_AVAILABLE`

Page-level extension behavior remains covered by Chromium E2E. Firefox-specific manifest behavior is covered by unit tests, and native Firefox loading is covered by the `web-ext` smoke.
