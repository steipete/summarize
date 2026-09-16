// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { friendlyFetchError } from "../apps/chrome-extension/src/entrypoints/background/daemon-client.js";
import { isTransientDaemonState } from "../apps/chrome-extension/src/lib/daemon-status.js";
import {
  applyExtensionLocale,
  extensionMessage,
  LocalizedError,
  message,
  readLocalizedMessage,
  setText,
} from "../apps/chrome-extension/src/lib/i18n.js";

afterEach(() => {
  applyExtensionLocale("en")();
  document.body.replaceChildren();
});

describe("network error localization across the extension wire", () => {
  it.each([
    "daemonSlides",
    "directProvider",
    "daemonRequest",
    "directChat",
    "daemonChat",
    "chatHistory",
    "health",
    "ping",
  ] as const)("keeps %s guidance translatable after JSON transport", (context) => {
    const wire = JSON.parse(
      JSON.stringify(friendlyFetchError(new TypeError("Failed to fetch"), context)),
    );
    const descriptor = readLocalizedMessage(wire.localized)!;
    expect(descriptor).toBeDefined();
    const element = document.createElement("div");
    document.body.append(element);
    setText(element, descriptor);
    expect(element.textContent).toBe(wire.message);
    applyExtensionLocale("tr");
    expect(element.textContent).not.toContain("Failed to fetch");
    expect(element.textContent).toContain("başarısız");
    if (context.startsWith("direct")) {
      expect(element.textContent).toContain("sağlayıcı kullanılamıyor");
      expect(element.textContent).not.toContain("summarize daemon status");
    } else {
      expect(element.textContent).toContain("summarize daemon status");
      expect(element.textContent).toContain("daemon.err.log");
    }
    applyExtensionLocale("en");
    expect(element.textContent).toBe(wire.message);
  });

  it("preserves native diagnostics and nested owned descriptors", () => {
    const native = friendlyFetchError(
      new Error("native[fixture]: invalid packet"),
      "directProvider",
    );
    expect(extensionMessage(native.localized.key, native.localized.values, "tr")).toContain(
      "native[fixture]: invalid packet",
    );
    const owned = friendlyFetchError(
      new LocalizedError(message("error.agentStreamEmpty")),
      "daemonChat",
    );
    const text = extensionMessage(owned.localized.key, owned.localized.values, "tr");
    expect(text).toContain("Ajan akışı yanıt vermeden sona erdi.");
    expect(text).not.toContain("Agent stream ended");
  });

  it("recognizes transient health failures by descriptors independently of their text", () => {
    expect(
      isTransientDaemonState({
        ok: false,
        authed: false,
        error: "fixture",
        localized: message("error.daemonTimeout"),
      }),
    ).toBe(true);
    expect(
      isTransientDaemonState({
        ok: false,
        authed: false,
        error: "fixture",
        localized: friendlyFetchError(new TypeError("Failed to fetch"), "health").localized,
      }),
    ).toBe(true);
  });
});
