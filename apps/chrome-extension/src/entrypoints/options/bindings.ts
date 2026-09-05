import type { createModelPresetsController } from "../../lib/model-presets";
import { normalizeDaemonPort } from "../../lib/settings";
import type { createLogsViewer } from "./logs-viewer";
import type { createProcessesViewer } from "./processes-viewer";

type OptionsBindingsArgs = {
  elements: {
    formEl: HTMLFormElement;
    tokenEl: HTMLInputElement;
    daemonPortEl: HTMLInputElement;
    tokenCopyBtn: HTMLButtonElement;
    modelPresetEl: HTMLSelectElement;
    modelCustomEl: HTMLInputElement;
    languagePresetEl: HTMLSelectElement;
    languageCustomEl: HTMLInputElement;
    promptOverrideEl: HTMLTextAreaElement;
    hoverPromptEl: HTMLTextAreaElement;
    hoverPromptResetBtn: HTMLButtonElement;
    maxCharsEl: HTMLInputElement;
    requestModeEl: HTMLSelectElement;
    firecrawlModeEl: HTMLSelectElement;
    markdownModeEl: HTMLSelectElement;
    preprocessModeEl: HTMLSelectElement;
    youtubeModeEl: HTMLSelectElement;
    transcriberEl: HTMLSelectElement;
    timeoutEl: HTMLInputElement;
    retriesEl: HTMLInputElement;
    maxOutputTokensEl: HTMLInputElement;
    autoCliOrderEl: HTMLInputElement;
    fontFamilyEl: HTMLInputElement;
    fontSizeEl: HTMLInputElement;
    logsSourceEl: HTMLSelectElement;
    logsTailEl: HTMLInputElement;
    logsParsedEl: HTMLInputElement;
    logsAutoEl: HTMLInputElement;
    logsLevelInputs: HTMLInputElement[];
  };
  scheduleAutoSave: (delay?: number) => void;
  saveNow: () => Promise<void>;
  checkDaemonStatus: (token: string) => void;
  modelPresets: ReturnType<typeof createModelPresetsController>;
  logsViewer: ReturnType<typeof createLogsViewer>;
  processesViewer: ReturnType<typeof createProcessesViewer>;
  copyToken: () => Promise<void>;
  refreshModelsIfStale: () => void;
  defaultHoverPrompt: string;
};

export function bindOptionsInputs({
  elements,
  scheduleAutoSave,
  saveNow,
  checkDaemonStatus,
  modelPresets,
  logsViewer,
  processesViewer,
  copyToken,
  refreshModelsIfStale,
  defaultHoverPrompt,
}: OptionsBindingsArgs) {
  let refreshTimer = 0;

  elements.tokenEl.addEventListener("input", () => {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
      void modelPresets.refreshPresets(elements.tokenEl.value);
      void checkDaemonStatus(elements.tokenEl.value);
      logsViewer.handleTokenChanged();
      processesViewer.handleTokenChanged();
    }, 350);
    scheduleAutoSave(600);
  });

  let portRefreshTimer = 0;
  elements.daemonPortEl.addEventListener("input", () => {
    window.clearTimeout(portRefreshTimer);
    portRefreshTimer = window.setTimeout(() => {
      elements.daemonPortEl.value = normalizeDaemonPort(elements.daemonPortEl.value);
      // Persist first: the daemon origin is derived from the saved port, so the
      // status/preset/log checks below must read the new port from storage.
      void saveNow().then(() => {
        void modelPresets.refreshPresets(elements.tokenEl.value);
        void checkDaemonStatus(elements.tokenEl.value);
        logsViewer.handleTokenChanged();
        processesViewer.handleTokenChanged();
      });
    }, 500);
  });

  elements.tokenCopyBtn.addEventListener("click", () => {
    void copyToken();
  });

  elements.modelPresetEl.addEventListener("focus", refreshModelsIfStale);
  elements.modelPresetEl.addEventListener("pointerdown", refreshModelsIfStale);
  elements.modelCustomEl.addEventListener("focus", refreshModelsIfStale);
  elements.modelCustomEl.addEventListener("pointerdown", refreshModelsIfStale);

  elements.languagePresetEl.addEventListener("change", () => {
    elements.languageCustomEl.hidden = elements.languagePresetEl.value !== "custom";
    if (!elements.languageCustomEl.hidden) elements.languageCustomEl.focus();
    scheduleAutoSave(200);
  });

  elements.hoverPromptResetBtn.addEventListener("click", () => {
    elements.hoverPromptEl.value = defaultHoverPrompt;
    scheduleAutoSave(200);
  });

  elements.modelPresetEl.addEventListener("change", () => {
    elements.modelCustomEl.hidden = elements.modelPresetEl.value !== "custom";
    if (!elements.modelCustomEl.hidden) elements.modelCustomEl.focus();
    scheduleAutoSave(200);
  });

  for (const input of [
    elements.modelCustomEl,
    elements.languageCustomEl,
    elements.promptOverrideEl,
    elements.hoverPromptEl,
  ]) {
    input.addEventListener("input", () => {
      scheduleAutoSave(600);
    });
  }

  elements.maxCharsEl.addEventListener("input", () => {
    scheduleAutoSave(400);
  });

  for (const select of [
    elements.requestModeEl,
    elements.firecrawlModeEl,
    elements.markdownModeEl,
    elements.preprocessModeEl,
    elements.youtubeModeEl,
    elements.transcriberEl,
  ]) {
    select.addEventListener("change", () => {
      scheduleAutoSave(200);
    });
  }

  for (const input of [
    elements.timeoutEl,
    elements.retriesEl,
    elements.maxOutputTokensEl,
    elements.autoCliOrderEl,
    elements.fontFamilyEl,
    elements.fontSizeEl,
  ]) {
    input.addEventListener("input", () => {
      scheduleAutoSave(
        input === elements.timeoutEl
          ? 400
          : input === elements.fontFamilyEl
            ? 600
            : input === elements.retriesEl ||
                input === elements.maxOutputTokensEl ||
                input === elements.autoCliOrderEl ||
                input === elements.fontSizeEl
              ? 300
              : 600,
      );
    });
  }

  elements.logsSourceEl.addEventListener("change", () => {
    void logsViewer.refresh();
  });

  elements.logsTailEl.addEventListener("change", () => {
    void logsViewer.refresh();
  });

  elements.logsParsedEl.addEventListener("change", () => {
    logsViewer.render();
  });

  for (const input of elements.logsLevelInputs) {
    input.addEventListener("change", () => {
      logsViewer.render();
    });
  }

  elements.logsAutoEl.addEventListener("change", () => {
    if (elements.logsAutoEl.checked) {
      logsViewer.startAuto();
      void logsViewer.refresh();
    } else {
      logsViewer.stopAuto();
    }
  });

  window.addEventListener("beforeunload", () => {
    logsViewer.stopAuto();
  });

  elements.formEl.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveNow();
  });
}
