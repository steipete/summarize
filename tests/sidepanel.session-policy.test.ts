import { describe, expect, it } from "vitest";
import {
  resolvePanelNavigationDecision,
  shouldAcceptRunForCurrentPage,
  shouldAcceptSlidesForCurrentPage,
  shouldIgnoreTransientPanelTabState,
  shouldInvalidateCurrentSource,
} from "../apps/chrome-extension/src/entrypoints/sidepanel/session-policy.js";
import {
  isPanelContentUrl as isMatchablePanelUrl,
  normalizePanelUrl,
  panelUrlsMatch,
} from "../apps/chrome-extension/src/lib/panel-url.js";

describe("sidepanel session policy", () => {
  it("preserves chat and migrates it on a tab switch when asked", () => {
    expect(
      resolvePanelNavigationDecision({
        activeTabId: 1,
        activeTabUrl: "https://example.com/a",
        nextTabId: 2,
        nextTabUrl: "https://example.com/b",
        hasActiveChat: true,
        chatEnabled: true,
        preserveChat: true,
        preferUrlMode: true,
        inputModeOverride: "page",
      }),
    ).toEqual({
      kind: "tab",
      preserveChat: true,
      shouldAbortChatStream: false,
      shouldClearChat: false,
      shouldMigrateChat: true,
      nextInputMode: "video",
      resetInputModeOverride: true,
    });
  });

  it("clears chat on a same-tab url change", () => {
    expect(
      resolvePanelNavigationDecision({
        activeTabId: 2,
        activeTabUrl: "https://example.com/a",
        nextTabId: 2,
        nextTabUrl: "https://example.com/b",
        hasActiveChat: true,
        chatEnabled: true,
        preserveChat: false,
        preferUrlMode: false,
        inputModeOverride: null,
      }),
    ).toEqual({
      kind: "url",
      preserveChat: false,
      shouldAbortChatStream: false,
      shouldClearChat: true,
      shouldMigrateChat: false,
      nextInputMode: "page",
      resetInputModeOverride: false,
    });
  });

  it("accepts a summary run for the current page even when only the active tab url is known", () => {
    expect(
      shouldAcceptRunForCurrentPage({
        runUrl: "https://www.youtube.com/watch?v=abc123&t=5",
        activeTabUrl: "https://www.youtube.com/watch?v=abc123",
        currentSourceUrl: null,
      }),
    ).toBe(true);
  });

  it("rejects a stale summary run for another page", () => {
    expect(
      shouldAcceptRunForCurrentPage({
        runUrl: "https://www.youtube.com/watch?v=alpha123",
        activeTabUrl: "https://www.youtube.com/watch?v=bravo456",
        currentSourceUrl: null,
      }),
    ).toBe(false);
  });

  it("does not reject a real run when the only known active url is the extension page", () => {
    expect(
      shouldAcceptRunForCurrentPage({
        runUrl: "https://example.com/video",
        activeTabUrl: "chrome-extension://test/sidepanel.html",
        currentSourceUrl: null,
      }),
    ).toBe(true);
  });

  it("rejects a stale slides run for another page", () => {
    expect(
      shouldAcceptSlidesForCurrentPage({
        targetUrl: "https://www.youtube.com/watch?v=alpha123",
        activeTabUrl: "https://www.youtube.com/watch?v=bravo456",
        currentSourceUrl: null,
      }),
    ).toBe(false);
  });

  it("invalidates the current source when the active page changes", () => {
    expect(
      shouldInvalidateCurrentSource({
        stateTabUrl: "https://example.com/b",
        currentSourceUrl: "https://example.com/a",
      }),
    ).toBe(true);
  });

  it("normalizes hashes and equivalent youtube urls", () => {
    expect(normalizePanelUrl("https://example.com/a#hash")).toBe("https://example.com/a");
    expect(
      panelUrlsMatch(
        "https://www.youtube.com/watch?v=abc123",
        "https://www.youtube.com/watch?v=abc123&t=10",
      ),
    ).toBe(true);
  });

  it("treats extension and blank urls as transient when a real source is already active", () => {
    expect(isMatchablePanelUrl("chrome-extension://test/sidepanel.html")).toBe(false);
    expect(
      shouldIgnoreTransientPanelTabState({
        nextTabUrl: "chrome-extension://test/sidepanel.html",
        activeTabUrl: "https://www.youtube.com/watch?v=abc123",
        currentSourceUrl: null,
      }),
    ).toBe(true);
    expect(
      shouldIgnoreTransientPanelTabState({
        nextTabUrl: null,
        activeTabUrl: null,
        currentSourceUrl: "https://www.youtube.com/watch?v=abc123",
      }),
    ).toBe(true);
    expect(
      shouldIgnoreTransientPanelTabState({
        nextTabUrl: "https://www.youtube.com/watch?v=abc123",
        activeTabUrl: "https://www.youtube.com/watch?v=abc123",
        currentSourceUrl: null,
      }),
    ).toBe(false);
  });
});
