import { describe, expect, it } from 'vitest'

import { extractYoutubeBootstrapConfig } from '../packages/core/src/content/transcript/utils.js'

describe('YouTube bootstrap parsing', () => {
  it('parses nested ytcfg.set objects (balanced braces)', () => {
    const html = `
      <html><head>
      <script>window.ytcfg.set('EMERGENCY_BASE_URL','/error_204');</script>
      <script>ytcfg.set({"INNERTUBE_API_KEY":"TEST_KEY","INNERTUBE_CONTEXT":{"client":{"clientName":"WEB","clientVersion":"1.0"}},"EXPERIMENT_FLAGS":{"nested":{"a":1,"b":{"c":2}}}});</script>
      </head><body></body></html>
    `.trim()

    const config = extractYoutubeBootstrapConfig(html)
    expect(config).not.toBeNull()
    expect(config?.INNERTUBE_API_KEY).toBe('TEST_KEY')
    expect(config?.INNERTUBE_CONTEXT).toEqual(
      expect.objectContaining({
        client: expect.objectContaining({ clientName: 'WEB' }),
      })
    )
  })
})
