import { describe, expect, it } from 'vitest'
import { GrayscaleSample } from '../lib/frameCapture'
import {
  ERASURE_FRACTION,
  MIN_FLUSH_GAP_MS,
  MIN_SEND_INTERVAL_MS,
  NotesTriggerInput,
  changedTileFraction,
  decideNotesAction,
} from '../lib/notesTrigger'

const base: NotesTriggerInput = {
  nowMs: 100_000,
  calm: true,
  hasSent: true,
  diffFromSent: 0,
  diffFromStable: null,
  lastSentAtMs: 0,
  stableCapturedAtMs: null,
}

describe('decideNotesAction', () => {
  it('sends the first calm frame and waits while the board is moving', () => {
    expect(decideNotesAction({ ...base, hasSent: false })).toBe('send_now')
    expect(decideNotesAction({ ...base, hasSent: false, calm: false })).toBe('none')
  })

  it('does nothing for an unchanged calm board', () => {
    expect(decideNotesAction(base)).toBe('none')
  })

  it('sends on significant change only after the minimum interval', () => {
    const changed = { ...base, diffFromSent: 0.08 }
    // Too soon to send, but the content is retained as a stable candidate.
    expect(decideNotesAction({ ...changed, lastSentAtMs: changed.nowMs - 1000 })).toBe('capture_stable')
    expect(decideNotesAction({ ...changed, lastSentAtMs: changed.nowMs - MIN_SEND_INTERVAL_MS })).toBe('send_now')
  })

  it('retains a stable candidate for minor change, refreshing at most periodically', () => {
    const minor = { ...base, diffFromSent: 0.02, lastSentAtMs: base.nowMs - 1000 }
    expect(decideNotesAction(minor)).toBe('capture_stable')
    expect(decideNotesAction({ ...minor, stableCapturedAtMs: base.nowMs - 1000 })).toBe('none')
  })

  it('flushes the stable frame when the board is erased, even while not calm', () => {
    const erased = {
      ...base,
      calm: false,
      diffFromStable: ERASURE_FRACTION + 0.01,
      lastSentAtMs: base.nowMs - MIN_FLUSH_GAP_MS,
    }
    expect(decideNotesAction(erased)).toBe('flush_stable')
    expect(decideNotesAction({ ...erased, lastSentAtMs: base.nowMs - 100 })).toBe('none')
  })
})

describe('changedTileFraction', () => {
  const sample = (fill: number): GrayscaleSample => ({ width: 64, height: 64, data: new Uint8Array(64 * 64).fill(fill) })

  it('is 0 for identical frames and reflects the share of changed tiles', () => {
    const a = sample(30)
    expect(changedTileFraction(a, sample(30), null)).toBe(0)
    const data = new Uint8Array(a.data)
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) data[y * 64 + x] = 200
    // 1 of 16 tiles differs (global brightness offset stays below the pixel delta).
    const f = changedTileFraction(a, { ...a, data }, null)
    expect(f).toBeCloseTo(1 / 16, 5)
  })

  it('treats a size mismatch as fully changed', () => {
    expect(changedTileFraction(sample(0), { width: 32, height: 32, data: new Uint8Array(1024) }, null)).toBe(1)
  })
})
