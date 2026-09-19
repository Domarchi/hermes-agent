import { describe, expect, it } from 'vitest'

import { parseDesktopCapabilities } from './desktop-plugin-manifest'

describe('parseDesktopCapabilities', () => {
  it('reads block and inline lists, ignoring comments and quotes', () => {
    expect(
      parseDesktopCapabilities(
        [
          'name: weather',
          'desktop_capabilities:',
          '  - ui',
          "  - 'os:clipboard'  # copy button",
          '',
          '  - gateway:request',
          'tools:',
          '  - x'
        ].join('\n')
      )
    ).toEqual(['ui', 'os:clipboard', 'gateway:request'])

    expect(parseDesktopCapabilities('desktop_capabilities: [ui, "storage", rest:any]\nname: x')).toEqual([
      'ui',
      'storage',
      'rest:any'
    ])
  })

  it('distinguishes "no declaration" (defaults apply) from an explicit empty list', () => {
    expect(parseDesktopCapabilities('name: weather\nversion: 1')).toBeUndefined()
    expect(parseDesktopCapabilities('desktop_capabilities: []')).toEqual([])
  })
})
