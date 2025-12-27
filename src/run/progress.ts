export type ProgressGate = {
  setClearProgressBeforeStdout: (fn: (() => void) | null) => void
  clearProgressForStdout: () => void
  clearProgressIfCurrent: (fn: () => void) => void
}

export function createProgressGate(): ProgressGate {
  let clearFn: (() => void) | null = null

  return {
    setClearProgressBeforeStdout: (fn) => {
      clearFn = fn
    },
    clearProgressForStdout: () => {
      clearFn?.()
    },
    clearProgressIfCurrent: (fn) => {
      if (clearFn === fn) {
        clearFn = null
      }
    },
  }
}
