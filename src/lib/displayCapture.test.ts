import { describe, expect, it } from 'vitest'
import { buildDisplayMediaOptions, isLikelySelfCapture } from './displayCapture'

describe('buildDisplayMediaOptions', () => {
  it('excludes the current tab and audio', () => {
    const o = buildDisplayMediaOptions()
    expect(o.selfBrowserSurface).toBe('exclude')
    expect(o.preferCurrentTab).toBe(false)
    expect(o.audio).toBe(false)
    expect(o.systemAudio).toBe('exclude')
  })
})

describe('isLikelySelfCapture', () => {
  it('flags a tab whose label equals the page title', () => {
    expect(isLikelySelfCapture('Chalkolate', 'browser', 'chalkolate ')).toBe(true)
  })
  it('does not flag other tabs', () => {
    expect(isLikelySelfCapture('Lecture 4 - Slides', 'browser', 'Chalkolate')).toBe(false)
  })
  it('flags a window label containing the title', () => {
    expect(isLikelySelfCapture('Chalkolate - Google Chrome', 'window', 'Chalkolate')).toBe(true)
  })
  it('does not flag tabs that merely contain the title', () => {
    expect(isLikelySelfCapture('Chalkolate docs', 'browser', 'Chalkolate')).toBe(false)
  })
  it('never flags monitors, empty labels or tiny titles', () => {
    expect(isLikelySelfCapture('Chalkolate', 'monitor', 'Chalkolate')).toBe(false)
    expect(isLikelySelfCapture('', 'browser', 'Chalkolate')).toBe(false)
    expect(isLikelySelfCapture('a', 'window', 'a')).toBe(false)
  })
  it('handles unknown surface by allowing contains', () => {
    expect(isLikelySelfCapture('Chalkolate — Safari', undefined, 'Chalkolate')).toBe(true)
  })
})
