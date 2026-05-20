export function createOptionsSaveRuntime(options: {
  isInitializing: () => boolean;
  setStatus: (text: string) => void;
  flashStatus: (text: string, duration?: number) => void;
  persist: () => Promise<void>;
}) {
  const { isInitializing, setStatus, flashStatus, persist } = options;
  let saveTimer = 0;
  let saveInFlight = false;
  let saveQueued = false;
  let saveSequence = 0;

  const formatSaveError = (error: unknown) => {
    const message = error instanceof Error ? error.message.trim() : String(error).trim();
    return message ? `Save failed: ${message}` : "Save failed";
  };

  const saveNow = async () => {
    if (saveInFlight) {
      saveQueued = true;
      return;
    }
    saveInFlight = true;
    saveQueued = false;
    const currentSeq = ++saveSequence;
    setStatus("Saving…");
    try {
      await persist();
      if (currentSeq === saveSequence) {
        flashStatus("Saved");
      }
    } catch (error) {
      if (currentSeq === saveSequence) {
        setStatus(formatSaveError(error));
      }
    } finally {
      saveInFlight = false;
      if (saveQueued) {
        saveQueued = false;
        void saveNow();
      }
    }
  };

  const scheduleAutoSave = (delay = 500) => {
    if (isInitializing()) return;
    globalThis.clearTimeout(saveTimer);
    saveTimer = globalThis.setTimeout(() => {
      void saveNow();
    }, delay);
  };

  return { saveNow, scheduleAutoSave };
}
