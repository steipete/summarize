# Firefox Compatibility Guide

This document details Firefox-specific implementation notes, API compatibility findings, and known differences between the Chrome and Firefox versions of the Summarize extension.

## Chrome API Usage Investigation

### Standard WebExtensions APIs (Compatible)

The following Chrome APIs are used throughout the extension and have direct Firefox equivalents via the `browser.*` namespace. WXT automatically polyfills these:

#### Core Extension APIs
- **`chrome.runtime`**: Message passing, extension info, connections
  - `runtime.onMessage`, `runtime.sendMessage`
  - `runtime.onConnect`, `runtime.connect`, `runtime.Port`
  - `runtime.getURL`, `runtime.getManifest`
  - `runtime.openOptionsPage`
  - ✅ **Firefox compatible** (all methods supported)

- **`chrome.tabs`**: Tab management and queries
  - `tabs.query`, `tabs.get`, `tabs.create`, `tabs.update`
  - `tabs.sendMessage`
  - `tabs.onActivated`, `tabs.onUpdated`
  - ✅ **Firefox compatible**

- **`chrome.storage`**: Persistent and session storage
  - `storage.local.get`, `storage.local.set`
  - `storage.session` (used for ephemeral data)
  - `storage.onChanged`
  - ⚠️ **Mostly compatible** - `storage.session` requires Firefox 115+

- **`chrome.scripting`**: Dynamic content script injection
  - `scripting.executeScript`
  - ✅ **Firefox compatible** (MV3)

- **`chrome.windows`**: Window management
  - `windows.getCurrent`, `windows.create`, `windows.update`
  - ✅ **Firefox compatible**

- **`chrome.webNavigation`**: Navigation events
  - `webNavigation.onHistoryStateUpdated`
  - ✅ **Firefox compatible**

- **`chrome.permissions`**: Runtime permissions
  - `permissions.contains`, `permissions.request`
  - ✅ **Firefox compatible**

### Chrome-Specific APIs (Requires Attention)

#### 1. Side Panel API (Primary Incompatibility)

**Chrome usage** (`wxt.config.ts:56, 77-79`, `background.ts:1583`):
```typescript
// Manifest
side_panel: {
  default_path: 'sidepanel/index.html',
}

// Runtime API
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true })
```

**Firefox equivalent**: `sidebar_action` API (Firefox 131+)
```typescript
// Manifest override needed
sidebar_action: {
  default_panel: 'sidepanel.html',
  default_title: 'Summarize',
  default_icon: 'assets/icon-128.png'
}
```

**Migration notes**:
- Firefox sidebar is always visible in the sidebar (not a side panel that slides in)
- No equivalent to `setPanelBehavior` - sidebar is opened manually
- Same HTML content can be reused (sidepanel.html)
- UI may need minor adjustments for Firefox sidebar dimensions

**Files affected**:
- `wxt.config.ts` - Needs Firefox manifest override
- `src/entrypoints/background.ts:1583` - setPanelBehavior call should be Chrome-only

#### 2. Debugger API (Advanced Features)

**Usage** (`background.ts:407-480`, `automation/tools.ts:336-366`):
```typescript
chrome.debugger.attach({ tabId }, '1.3')
chrome.debugger.sendCommand({ tabId }, method, params)
chrome.debugger.detach({ tabId })
```

**Firefox compatibility**: ✅ **Supported** but may have behavioral differences
- Firefox has `browser.debugger` with same API surface
- Used for automation features (CDP commands)
- Requires `debugger` permission (already declared)
- **Testing needed**: Verify CDP protocol compatibility

#### 3. UserScripts API (Optional)

**Usage** (`automation/userscripts.ts:14-16`, `background.ts`, `automation/repl.ts:142-171`):
```typescript
chrome.userScripts
chrome.permissions.contains({ permissions: ['userScripts'] })
```

**Firefox compatibility**: ⚠️ **Limited support**
- Firefox has experimental `browser.userScripts` support
- Available in Firefox 128+ behind `extensions.userScripts.enabled` pref
- Less mature than Chrome implementation
- **Recommendation**: Feature-detect and gracefully degrade if unavailable

### Storage Quota Considerations

**Current usage pattern**: Caching summaries, settings, and session data

**Chrome quotas**:
- `storage.local`: ~10 MB (can request more with `unlimitedStorage`)
- `storage.session`: ~10 MB

**Firefox quotas**:
- `storage.local`: 10 MB default (same as Chrome)
- `storage.session`: 10 MB (Firefox 115+)

**Action required**:
- Monitor cache size in production
- Implement LRU eviction if approaching limits
- Consider adding warnings at 80% capacity

## Manifest Differences

### Required Changes for Firefox

**Chrome manifest** (current):
```json
{
  "permissions": ["sidePanel", ...],
  "side_panel": {
    "default_path": "sidepanel/index.html"
  }
}
```

**Firefox manifest override** (needed):
```json
{
  "permissions": ["tabs", "activeTab", "storage", ...],
  "sidebar_action": {
    "default_panel": "sidepanel/index.html",
    "default_title": "Summarize"
  }
}
```

**Permissions to verify**:
- Remove `sidePanel` (Chrome-only)
- Verify `debugger` permission works in Firefox
- Verify `userScripts` in `optional_permissions` is handled gracefully

## Service Worker vs Background Page

**Current**: Chrome MV3 service worker (`background.ts`)

**Firefox MV3**: Also uses service workers (Firefox 109+)
- Same lifecycle as Chrome
- Same event-driven model
- SSE connection handling should work identically

**Testing priorities**:
1. Verify service worker restarts properly
2. Test SSE streaming during worker lifecycle
3. Verify port-based communication (sidepanel ↔ background)

## Content Script Timing

**Current injection strategy**:
- `extract.content.ts`: Readability-based extraction
- `hover.content.ts`: Hover summaries
- `automation.content.ts`: Automation features

**Firefox compatibility**: ✅ **Should work identically**
- WXT handles content script registration
- Same `run_at` timing behavior
- Same message passing APIs

## SSE/EventSource Support

**Usage**: Streaming summaries from daemon via SSE (`src/lib/sse.ts`)

**Testing needed**:
- Verify EventSource works in Firefox background context
- Test reconnection logic on Firefox
- Verify CORS headers work with Firefox origin

## Known Behavioral Differences

### 1. Sidebar vs Side Panel UX

**Chrome Side Panel**:
- Slides in from the right
- Can be programmatically opened
- Toggles on toolbar icon click (with `setPanelBehavior`)

**Firefox Sidebar**:
- Always visible in sidebar area (left side by default)
- User manually opens/closes via View menu or Ctrl+B
- No programmatic open/close API
- Different width constraints

**Impact**: Users need to manually open sidebar on first use

### 2. Extension Context URLs

**Chrome**: `chrome-extension://<id>/...`
**Firefox**: `moz-extension://<id>/...`

**Impact**: Minimal - WXT handles this via `runtime.getURL()`

### 3. Developer Tools Integration

**Chrome**: DevTools open via `chrome://extensions`
**Firefox**: DevTools open via `about:debugging`

**Impact**: Documentation only

## Testing Strategy

### Browser Compatibility Tags

Add tags to Playwright tests:

```typescript
// @cross-browser - Runs on both Chrome and Firefox
test('@cross-browser should generate pairing token', ...)

// @firefox - Firefox-specific tests
test('@firefox should use sidebar API', ...)

// @chrome - Chrome-specific tests
test('@chrome should use Side Panel API', ...)
```

### Test Execution

```bash
# All tests (both browsers)
pnpm test

# Firefox only
pnpm test:firefox

# Chrome only
pnpm test:chrome
```

### Critical Test Scenarios

1. **Pairing flow**: Token generation and daemon connection
2. **Summary streaming**: SSE stream rendering in sidebar
3. **Content extraction**: Readability on various sites
4. **Auto-summarize**: Navigation triggers
5. **Settings persistence**: storage.local across restarts
6. **Permissions**: Debugger and userScripts optional permissions

## Development Workflow

### Building for Firefox

```bash
# Development mode (watch)
pnpm dev:firefox

# Production build
pnpm build:firefox

# Output location
.output/firefox-mv3/
```

### Loading in Firefox

1. Open `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on"
3. Select `apps/chrome-extension/.output/firefox-mv3/manifest.json`

**Note**: Temporary add-ons are removed on browser restart

### Debugging

**Console logs**:
- Background script: `about:debugging` → This Firefox → Inspect
- Content scripts: Regular DevTools Console (per-page)
- Sidebar: Right-click sidebar → Inspect

**Common issues**:
- **"Error: Extension is invalid"**: Check manifest syntax
- **"Loading failed"**: Check console for missing permissions
- **Sidebar not rendering**: Verify `sidebar_action` in manifest

## Distribution

### Temporary Installation (Current)

- Use `about:debugging` → Load Temporary Add-on
- Extension removed on Firefox restart
- Suitable for development and early beta testing

### Future: AMO (Add-ons.mozilla.org)

When ready for public distribution:
1. Submit to AMO for review
2. Code signing required (automatic via AMO)
3. Update mechanism via AMO (similar to Chrome Web Store)

## Implementation Checklist

- [x] Investigate Chrome API usage
- [x] Document Chrome-specific APIs
- [ ] Create WXT Firefox target configuration
- [ ] Add `sidebar_action` manifest override
- [ ] Test sidebar rendering in Firefox
- [ ] Verify SSE streaming works
- [ ] Test debugger API for automation features
- [ ] Handle userScripts gracefully if unavailable
- [ ] Add browser compatibility test tags
- [ ] Configure Playwright for Firefox
- [ ] Run full test suite on Firefox build
- [ ] Manual testing in Firefox Developer Edition
- [ ] Update user-facing documentation

## References

- [Firefox Extension Workshop](https://extensionworkshop.com/)
- [WebExtensions API](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions)
- [Firefox Sidebar API](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/sidebarAction)
- [WXT Framework - Multi-Browser Support](https://wxt.dev/guide/multi-browser.html)
- [Firefox Extension Debugging](https://extensionworkshop.com/documentation/develop/debugging/)

## Open Questions

1. **UserScripts API**: How critical is this feature? Can we ship without it on Firefox?
2. **Sidebar width**: Do we need CSS adjustments for Firefox sidebar dimensions?
3. **Testing coverage**: Should we maintain 100% feature parity or allow browser-specific features?
4. **Distribution timeline**: When to submit to AMO?

---

**Last updated**: 2026-01-01
**Status**: Initial investigation complete, implementation in progress
