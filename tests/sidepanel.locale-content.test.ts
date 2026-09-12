// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChatQueueRuntime } from "../apps/chrome-extension/src/entrypoints/sidepanel/chat-queue-runtime";
import { createInitialPanelState } from "../apps/chrome-extension/src/entrypoints/sidepanel/panel-state-store";
import { renderSummaryEmptyState } from "../apps/chrome-extension/src/entrypoints/sidepanel/summary-renderer";
import { applyExtensionLocale } from "../apps/chrome-extension/src/lib/i18n";

const html = readFileSync("apps/chrome-extension/src/entrypoints/sidepanel/index.html", "utf8");
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("sidepanel localized content preservation", () => {
  let stop = () => {};
  beforeEach(() => {
    document.body.innerHTML = (html.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1] ?? "").replace(
      /<script\b[^>]*>[\s\S]*?<\/script>/g,
      "",
    );
    document.body.setAttribute("data-locale-ui", "");
  });
  afterEach(() => {
    stop();
    document.body.replaceChildren();
    document.body.removeAttribute("data-locale-ui");
  });

  it("preserves queued prompt previews, tooltips and sent text across locale changes", async () => {
    const queue = createChatQueueRuntime({
      panelState: createInitialPanelState(),
      chatQueueEl: document.querySelector<HTMLElement>("#chatQueue")!,
      maxQueue: 3,
      setStatus: vi.fn(),
    });
    stop = applyExtensionLocale("tr");
    queue.enqueueChatMessage("Try again");
    await flush();
    for (const locale of ["tr", "en", "tr"] as const) {
      stop = applyExtensionLocale(locale);
      await flush();
      const text = document.querySelector<HTMLElement>(".chatQueueText")!;
      expect(text.textContent).toBe("Try again");
      expect(text.title).toBe("Try again");
      expect(document.querySelector(".chatQueueRemove")?.getAttribute("aria-label")).toBe(
        locale === "tr" ? "Kuyruğa alınmış mesajı kaldır" : "Remove queued message",
      );
    }
    expect(queue.dequeueQueuedMessage()?.text).toBe("Try again");
    queue.renderChatQueue();
    expect(document.querySelector(".chatQueueText")).toBeNull();
  });

  it("preserves source titles and rerendered empty-state details while translating controls", async () => {
    const title = document.querySelector<HTMLElement>("#title")!;
    const hostEl = document.querySelector<HTMLElement>("#render")!;
    stop = applyExtensionLocale("tr");
    for (const source of ["Error", "Try again", "Loading logs…"]) {
      title.textContent = source;
      title.title = source;
      renderSummaryEmptyState({
        hostEl,
        state: { label: "Summarize", message: "Try again", detail: source },
      });
      await flush();
      for (const locale of ["tr", "en", "tr"] as const) {
        stop = applyExtensionLocale(locale);
        await flush();
        expect(title.textContent).toBe(source);
        expect(title.title).toBe(source);
        expect(hostEl.querySelector(".renderEmpty__detail")?.textContent).toBe(source);
        expect(hostEl.querySelector(".renderEmpty__message")?.textContent).toBe(
          locale === "tr" ? "Tekrar dene" : "Try again",
        );
      }
    }
  });
});
