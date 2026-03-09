import { defineContentScript } from "wxt/utils/define-content-script";
import { isDeniedHost } from "../lib/denylist";

export type ElementInfo = {
  selector: string;
  xpath: string;
  html: string;
  tagName: string;
  attributes: Record<string, string>;
  text: string;
  boundingBox: { x: number; y: number; width: number; height: number };
};

declare global {
  interface Window {
    __summarizeElementPicker?: boolean;
    __summarizeReplOverlay?: boolean;
  }
}

function generateSelector(element: Element): string {
  if (element.id) return `#${CSS.escape(element.id)}`;
  const path: string[] = [];
  let current: Element | null = element;
  while (current && current !== document.body) {
    let selector = current.tagName.toLowerCase();
    if (current.className && typeof current.className === "string") {
      const classes = current.className
        .split(/\s+/)
        .filter((c) => c && !c.startsWith("summarize-"));
      if (classes.length > 0) {
        selector += `.${classes.map((c) => CSS.escape(c)).join(".")}`;
      }
    }
    if (current.parentElement) {
      const tagName = current.tagName;
      const siblings = Array.from(current.parentElement.children).filter(
        (el) => el.tagName === tagName,
      );
      if (siblings.length > 1) {
        const index = siblings.indexOf(current) + 1;
        selector += `:nth-child(${index})`;
      }
    }
    path.unshift(selector);
    current = current.parentElement;
  }
  return path.join(" > ");
}

function generateXPath(element: Element): string {
  if (element.id) return `//*[@id="${element.id}"]`;
  const path: string[] = [];
  let current: Element | null = element;
  while (current && current !== document.documentElement) {
    let index = 0;
    let sibling = current.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === current.tagName) index++;
      sibling = sibling.previousElementSibling;
    }
    const tag = current.tagName.toLowerCase();
    const position = index > 0 ? `[${index + 1}]` : "";
    path.unshift(`${tag}${position}`);
    current = current.parentElement;
  }
  return `/${path.join("/")}`;
}

function getElementInfo(element: Element): ElementInfo {
  const rect = element.getBoundingClientRect();
  const attributes: Record<string, string> = {};
  for (const attr of Array.from(element.attributes)) {
    attributes[attr.name] = attr.value;
  }
  return {
    selector: generateSelector(element),
    xpath: generateXPath(element),
    html: element.outerHTML.slice(0, 2000),
    tagName: element.tagName.toLowerCase(),
    attributes,
    text: element.textContent?.trim() ?? "",
    boundingBox: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
  };
}

async function createElementPicker(message?: string): Promise<ElementInfo> {
  if (window.__summarizeElementPicker) {
    throw new Error("Element picker already active");
  }
  window.__summarizeElementPicker = true;

  return new Promise((resolve, reject) => {
    const overlay = document.createElement("div");
    overlay.id = "__summarize_element_picker__";
    overlay.style.cssText = `
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      pointer-events: none;
    `;

    const highlight = document.createElement("div");
    highlight.style.cssText = `
      position: absolute;
      pointer-events: none;
      border: 2px solid #3b82f6;
      background: rgba(59, 130, 246, 0.12);
      box-shadow: 0 0 0 1px rgba(59, 130, 246, 0.5);
      transition: all 0.08s ease;
    `;
    overlay.appendChild(highlight);

    const banner = document.createElement("div");
    banner.style.cssText = `
      position: fixed;
      top: 16px;
      left: 50%;
      transform: translateX(-50%);
      background: #111827;
      color: white;
      padding: 10px 18px;
      border-radius: 8px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 13px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
      display: flex;
      align-items: center;
      gap: 12px;
      pointer-events: auto;
    `;

    const bannerText = document.createElement("span");
    bannerText.textContent = message || "Click an element to select • ↑↓ to change depth";
    banner.appendChild(bannerText);

    const cancelButton = document.createElement("button");
    cancelButton.textContent = "Cancel (Esc)";
    cancelButton.style.cssText = `
      background: #1f2937;
      border: none;
      color: white;
      padding: 4px 10px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
    `;
    banner.appendChild(cancelButton);

    document.body.appendChild(overlay);
    document.body.appendChild(banner);

    let currentElement: Element | null = null;
    let ancestorIndex = 0;

    const cleanup = () => {
      overlay.remove();
      banner.remove();
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("keydown", onKey);
      cancelButton.removeEventListener("click", onCancel);
      window.__summarizeElementPicker = false;
    };

    const updateHighlight = (element: Element | null) => {
      if (!element) return;
      const rect = element.getBoundingClientRect();
      highlight.style.left = `${rect.left}px`;
      highlight.style.top = `${rect.top}px`;
      highlight.style.width = `${rect.width}px`;
      highlight.style.height = `${rect.height}px`;
    };

    const resolveCurrent = () => {
      if (!currentElement) return null;
      let el: Element | null = currentElement;
      for (let i = 0; i < ancestorIndex; i += 1) {
        if (el?.parentElement) el = el.parentElement;
      }
      return el;
    };

    const onMove = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target || target === overlay || target === banner) return;
      currentElement = target;
      const resolved = resolveCurrent();
      if (resolved) updateHighlight(resolved);
    };

    const onClick = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const resolved = resolveCurrent();
      if (!resolved) return;
      cleanup();
      resolve(getElementInfo(resolved));
    };

    const onCancel = () => {
      cleanup();
      reject(new Error("Selection cancelled"));
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCancel();
        return;
      }
      if (event.key === "ArrowUp") {
        ancestorIndex += 1;
      }
      if (event.key === "ArrowDown") {
        ancestorIndex = Math.max(0, ancestorIndex - 1);
      }
      const resolved = resolveCurrent();
      if (resolved) updateHighlight(resolved);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("click", onClick, true);
    window.addEventListener("keydown", onKey);
    cancelButton.addEventListener("click", onCancel);
  });
}

function showReplOverlay(message?: string) {
  if (window.__summarizeReplOverlay) return;
  window.__summarizeReplOverlay = true;

  const styleId = "__summarize_repl_overlay_style__";
  if (!document.getElementById(styleId)) {
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      @keyframes summarize-repl-pulse {
        0% { opacity: 0.3; }
        50% { opacity: 1; }
        100% { opacity: 0.3; }
      }
    `;
    document.head.appendChild(style);
  }

  const overlay = document.createElement("div");
  overlay.id = "__summarize_repl_overlay__";
  overlay.style.cssText = `
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    pointer-events: none;
  `;

  const card = document.createElement("div");
  card.style.cssText = `
    position: fixed;
    top: 16px;
    left: 50%;
    transform: translateX(-50%);
    background: #111827;
    color: white;
    padding: 10px 16px;
    border-radius: 999px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 13px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
    display: flex;
    align-items: center;
    gap: 12px;
    pointer-events: auto;
  `;

  const spinner = document.createElement("span");
  spinner.textContent = "● ● ●";
  spinner.style.cssText = `
    font-size: 10px;
    letter-spacing: 2px;
    animation: summarize-repl-pulse 1.4s ease-in-out infinite;
    opacity: 0.6;
  `;
  card.appendChild(spinner);

  const text = document.createElement("span");
  text.textContent = message ? `Running: ${message}` : "Running automation…";
  card.appendChild(text);

  const abortBtn = document.createElement("button");
  abortBtn.textContent = "Abort (Esc)";
  abortBtn.style.cssText = `
    background: #1f2937;
    border: none;
    color: white;
    padding: 4px 10px;
    border-radius: 999px;
    cursor: pointer;
    font-size: 12px;
  `;
  card.appendChild(abortBtn);

  overlay.appendChild(card);
  document.body.appendChild(overlay);

  const requestAbort = () => {
    void chrome.runtime.sendMessage({ type: "automation:abort-repl" });
    void chrome.runtime.sendMessage({ type: "automation:abort-agent" });
    hideReplOverlay();
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      requestAbort();
    }
  };

  abortBtn.addEventListener("click", requestAbort);
  window.addEventListener("keydown", onKey, true);

  (overlay as HTMLElement).dataset.cleanup = "true";
  (overlay as unknown as { __cleanup?: () => void }).__cleanup = () => {
    window.removeEventListener("keydown", onKey, true);
    abortBtn.removeEventListener("click", requestAbort);
  };
}

function hideReplOverlay() {
  const overlay = document.getElementById("__summarize_repl_overlay__");
  if (overlay) {
    (overlay as unknown as { __cleanup?: () => void }).__cleanup?.();
    overlay.remove();
  }
  window.__summarizeReplOverlay = false;
}

function handleNativeInputBridge() {
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data as { source?: string; requestId?: string; payload?: unknown };
    if (data?.source !== "summarize-native-input" || !data.requestId) return;
    const payload = data.payload as { action?: string };
    chrome.runtime.sendMessage(
      { type: "automation:native-input", payload },
      (response: { ok: boolean; error?: string } | undefined) => {
        window.postMessage(
          {
            source: "summarize-native-input",
            requestId: data.requestId,
            ok: response?.ok ?? false,
            error: response?.error,
          },
          "*",
        );
      },
    );
  });
}

// Bridge artifact RPC calls from userScripts (page world) to the extension.
function handleArtifactsBridge() {
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data as {
      source?: string;
      requestId?: string;
      action?: string;
      payload?: unknown;
    };
    if (data?.source !== "summarize-artifacts" || !data.requestId) return;
    chrome.runtime.sendMessage(
      {
        type: "automation:artifacts",
        requestId: data.requestId,
        action: data.action,
        payload: data.payload,
      },
      (response: { ok: boolean; result?: unknown; error?: string } | undefined) => {
        window.postMessage(
          {
            source: "summarize-artifacts",
            requestId: data.requestId,
            ok: response?.ok ?? false,
            result: response?.result,
            error: response?.error,
          },
          "*",
        );
      },
    );
  });
}

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_idle",
  main() {
    const denied = isDeniedHost(location.hostname);
    if (!denied) {
      handleNativeInputBridge();
      handleArtifactsBridge();
    }

    chrome.runtime.onMessage.addListener(
      (
        raw: { type?: string; message?: string | null; action?: string },
        _sender,
        sendResponse: (response: { ok: boolean; result?: ElementInfo; error?: string }) => void,
      ) => {
        if (denied) {
          sendResponse({ ok: false, error: "Summarize is disabled on this site." });
          return true;
        }
        if (raw?.type === "automation:pick-element") {
          void (async () => {
            try {
              const result = await createElementPicker(raw.message ?? undefined);
              sendResponse({ ok: true, result });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendResponse({ ok: false, error: message });
            }
          })();
          return true;
        }
        if (raw?.type === "automation:repl-overlay") {
          if (raw.action === "show") {
            showReplOverlay(raw.message ?? undefined);
          } else if (raw.action === "hide") {
            hideReplOverlay();
          }
          sendResponse({ ok: true });
          return;
        }
      },
    );
  },
});
