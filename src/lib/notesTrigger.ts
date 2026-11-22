import { CHANGED_TILE_FRACTION, tileChangeFractions } from './changeDetector'
import { GrayscaleSample } from './frameCapture'

/** Notes sampling cadence; much slower than the 160ms mistake-monitor loop. */
export const NOTES_SAMPLE_INTERVAL_MS = 500
/** Max fraction of tiles actively moving for the board to count as calm. */
export const NOTES_CALM_MOVING_FRACTION = 0.05
/** Consecutive calm ticks (about 1.5s) required before any capture. */
export const NOTES_CALM_TICKS = 3
/** Fraction of tiles differing from the last sent snapshot that is "new content". */
export const MINOR_CHANGE_FRACTION = 0.015
export const SIGNIFICANT_CHANGE_FRACTION = 0.04
/** Fraction of tiles differing from the last stable frame that signals erasure / scene change. */
export const ERASURE_FRACTION = 0.12
export const MIN_SEND_INTERVAL_MS = 15_000
export const MIN_FLUSH_GAP_MS = 5_000
export const STABLE_REFRESH_MS = 5_000

export type NotesAction = 'none' | 'send_now' | 'capture_stable' | 'flush_stable'

export interface NotesTriggerInput {
  nowMs: number
  /** Board has been calm for NOTES_CALM_TICKS consecutive ticks. */
  calm: boolean
  hasSent: boolean
  /** Fraction of valid tiles differing from the last sent snapshot (0 when none sent). */
  diffFromSent: number
  /** Fraction differing from the retained stable candidate; null when there is none. */
  diffFromStable: number | null
  lastSentAtMs: number
  stableCapturedAtMs: number | null
}

/**
 * Decides what the notes builder should do this tick. The board is snapshotted only when it is
 * calm and has substantially new content (enough time since the last send), or when the last
 * stable frame is about to be lost to erasure (flushing it first), never on every frame.
 */
export function decideNotesAction(i: NotesTriggerInput): NotesAction {
  if (
    i.diffFromStable !== null &&
    i.diffFromStable >= ERASURE_FRACTION &&
    i.nowMs - i.lastSentAtMs >= MIN_FLUSH_GAP_MS
  ) {
    return 'flush_stable'
  }
  if (!i.calm) return 'none'
  if (!i.hasSent) return 'send_now'
  if (i.diffFromSent >= SIGNIFICANT_CHANGE_FRACTION && i.nowMs - i.lastSentAtMs >= MIN_SEND_INTERVAL_MS) {
    return 'send_now'
  }
  if (
    i.diffFromSent >= MINOR_CHANGE_FRACTION &&
    (i.stableCapturedAtMs === null || i.nowMs - i.stableCapturedAtMs >= STABLE_REFRESH_MS)
  ) {
    return 'capture_stable'
  }
  return 'none'
}

/** Fraction of valid (non-masked) tiles whose content differs between two samples. */
export function changedTileFraction(
  a: GrayscaleSample,
  b: GrayscaleSample,
  mask: Uint8Array | null,
): number {
  if (a.width !== b.width || a.height !== b.height) return 1
  const fracs = tileChangeFractions(a, b, mask)
  let valid = 0
  let changed = 0
  for (const f of fracs) {
    if (Number.isNaN(f)) continue
    valid++
    if (f >= CHANGED_TILE_FRACTION) changed++
  }
  return valid > 0 ? changed / valid : 0
}
