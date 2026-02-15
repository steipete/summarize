export type ProgressGate = {
  setClearProgressBeforeStdout: (fn: (() => undefined | (() => void)) | null) => void;
  clearProgressForStdout: () => void;
  restoreProgressAfterStdout: () => void;
  clearProgressIfCurrent: (fn: () => void) => void;
};

export function createProgressGate(): ProgressGate {
  let clearFn: (() => undefined | (() => void)) | null = null;
  let restoreFn: (() => void) | null = null;

  return {
    setClearProgressBeforeStdout: (fn) => {
      clearFn = fn;
      restoreFn = null;
    },
    clearProgressForStdout: () => {
      if (!clearFn) return;
      // Once real stdout output begins, keep progress UI hidden to avoid
      // cursor-control races between spinner redraws (stderr) and streamed
      // summary text (stdout) in shared terminals.
      clearFn();
      clearFn = null;
      restoreFn = null;
    },
    restoreProgressAfterStdout: () => {
      if (!restoreFn) return;
      const restore = restoreFn;
      restoreFn = null;
      restore();
    },
    clearProgressIfCurrent: (fn) => {
      if (clearFn === fn) {
        clearFn = null;
        restoreFn = null;
      }
    },
  };
}
