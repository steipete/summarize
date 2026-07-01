import { describe, expect, it, vi } from "vitest";
import {
  createDaemonHintRuntime,
  shouldShowDaemonHint,
} from "../apps/chrome-extension/src/entrypoints/sidepanel/daemon-hint-runtime";
import type { UiState } from "../apps/chrome-extension/src/entrypoints/sidepanel/types";

function makeUiState(overrides: Partial<UiState["settings"]> = {}): UiState {
  return {
    panelOpen: true,
    daemon: { ok: false, authed: false },
    tab: { id: 1, url: "https://example.com", title: "Example" },
    media: null,
    stats: { pageWords: 100, videoDurationSeconds: null },
    settings: {
      autoSummarize: true,
      hoverSummaries: false,
      chatEnabled: true,
      automationEnabled: false,
      slidesEnabled: true,
      slidesParallel: true,
      slidesOcrEnabled: false,
      slidesLayout: "gallery",
      slideRuntime: "browser",
      summaryRuntime: "direct",
      providerConfigured: false,
      daemonAllowed: true,
      daemonManaged: false,
      daemonHintDismissed: false,
      fontSize: 14,
      lineHeight: 1.45,
      model: "auto",
      length: "long",
      tokenPresent: false,
      ...overrides,
    },
    status: "",
  };
}

function makeElement() {
  const classes = new Set(["hidden"]);
  return {
    querySelector: () => null,
    classList: {
      add: (value: string) => classes.add(value),
      remove: (value: string) => classes.delete(value),
      toggle: (value: string, force?: boolean) => {
        if (force === true) classes.add(value);
        else if (force === false) classes.delete(value);
        else if (classes.has(value)) classes.delete(value);
        else classes.add(value);
      },
      contains: (value: string) => classes.has(value),
    },
  } as unknown as HTMLElement;
}

function makeButton() {
  let onClick: (() => void) | null = null;
  return {
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      if (type !== "click") return;
      onClick =
        typeof listener === "function"
          ? () => listener({} as Event)
          : () => listener.handleEvent({} as Event);
    },
    click: () => onClick?.(),
  } as unknown as HTMLButtonElement;
}

describe("sidepanel daemon hint runtime", () => {
  it("shows only for the untouched local default without a ready daemon", () => {
    expect(shouldShowDaemonHint(makeUiState())).toBe(true);
    expect(
      shouldShowDaemonHint({
        ...makeUiState(),
        daemon: { ok: true, authed: true },
      }),
    ).toBe(false);
    expect(
      shouldShowDaemonHint({
        ...makeUiState(),
        daemon: { ok: true, authed: false },
      }),
    ).toBe(true);
    expect(shouldShowDaemonHint(makeUiState({ providerConfigured: true }))).toBe(false);
    expect(shouldShowDaemonHint(makeUiState({ summaryRuntime: "daemon" }))).toBe(false);
    expect(shouldShowDaemonHint(makeUiState({ slideRuntime: "daemon" }))).toBe(false);
    expect(shouldShowDaemonHint(makeUiState({ model: "openai/gpt-5" }))).toBe(false);
    expect(shouldShowDaemonHint(makeUiState({ daemonHintDismissed: true }))).toBe(false);
  });

  it("persists dismissal and keeps the hint hidden immediately", () => {
    const hintEl = makeElement();
    const closeBtn = makeButton();
    const patchSettings = vi.fn(async () => ({}));
    const runtime = createDaemonHintRuntime({
      hintEl,
      actionBtn: makeButton(),
      closeBtn,
      patchSettings,
      openOptions: vi.fn(),
    });

    runtime.update(makeUiState());
    expect(hintEl.classList.contains("hidden")).toBe(false);

    closeBtn.click();
    expect(hintEl.classList.contains("hidden")).toBe(true);
    expect(patchSettings).toHaveBeenCalledWith({ daemonHintDismissed: true });

    runtime.update(makeUiState());
    expect(hintEl.classList.contains("hidden")).toBe(true);
  });

  it("opens settings from the connect action", () => {
    const actionBtn = makeButton();
    const openOptions = vi.fn();
    createDaemonHintRuntime({
      hintEl: makeElement(),
      actionBtn,
      closeBtn: makeButton(),
      patchSettings: vi.fn(async () => ({})),
      openOptions,
    });

    actionBtn.click();
    expect(openOptions).toHaveBeenCalledOnce();
  });
});
