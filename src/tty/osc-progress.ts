import type { OscProgressController } from 'osc-progress'
import {
  createOscProgressController as createOscProgressControllerImpl,
  startOscProgress as startOscProgressImpl,
  supportsOscProgress as supportsOscProgressImpl,
} from 'osc-progress'

export type {
  OscProgressController,
  OscProgressOptions,
  OscProgressSupportOptions,
  OscProgressTerminator,
} from 'osc-progress'

export function createOscProgressController(
  options: import('osc-progress').OscProgressOptions
): OscProgressController {
  const controller = createOscProgressControllerImpl(options)
  const holdMs = 2000
  let lastPercentAt = 0

  return {
    setIndeterminate: (label: string) => {
      if (lastPercentAt > 0 && Date.now() - lastPercentAt < holdMs) {
        return
      }
      controller.setIndeterminate(label)
    },
    setPercent: (label: string, percent: number) => {
      lastPercentAt = Date.now()
      controller.setPercent(label, percent)
    },
    clear: () => {
      lastPercentAt = 0
      controller.clear()
    },
  }
}

export function startOscProgress(options: import('osc-progress').OscProgressOptions) {
  return startOscProgressImpl(options)
}

export function supportsOscProgress(
  env: Record<string, string | undefined>,
  isTty: boolean,
  options?: import('osc-progress').OscProgressSupportOptions
) {
  return supportsOscProgressImpl(env, isTty, options)
}
