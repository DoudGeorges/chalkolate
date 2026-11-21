import { describe, expect, it } from 'vitest'
import { SourceSpaceDetectedError } from '../api/schemas'
import {
  RegionStatus,
  classifyRegion,
  createDetectorState,
  updateDetector,
} from '../lib/changeDetector'
import { GrayscaleSample } from '../lib/frameCapture'
import {
  MISSES_TO_RESOLVE_CHANGED,
  MISSES_TO_RESOLVE_UNCHANGED,
  createInitialTrackerState,
  deduplicateFindings,
  dismissIssue,
  getIssuesPendingRecheck,
  markIssueSpoken,
  normalizeDetectedText,
  reconcileAnalysis,
  requestVerification,
  resetDismissed,
  undoLastDismissal,
} from '../lib/issueTracker'

const DUMMY_SAMPLE: GrayscaleSample = {
  width: 32,
  height: 18,
  data: new Uint8Array(32 * 18).fill(30),
}

function makeFinding(
  overrides: Partial<SourceSpaceDetectedError> = {},
): SourceSpaceDetectedError {
  return {
    category: 'math',
    detected_text: '(a + b)^2 = a^2 + b^2',
    correction_text: '(a + b)^2 = a^2 + 2ab + b^2',
    correction_latex: '(a + b)^2 = a^2 + 2ab + b^2',
    spoken_alert: 'Missing 2ab term.',
    explanation: 'Square of sum includes cross term 2ab.',
    box_2d: [100, 100, 200, 420],
    confidence: 0.94,
    ...overrides,
  }
}

describe('Persistent session issue tracker', () => {
  it('consolidates full-equation, LHS, and RHS duplicates for one integral mistake into a single tight finding', () => {
    const fullEq = makeFinding({
      detected_text: '∫ 2x dx = x^3 + C',
      correction_text: '∫ 2x dx = x^2 + C',
      explanation: 'The antiderivative of 2x is x^2 + C, not x^3 + C.',
      spoken_alert: 'Integral of 2x is x squared plus C.',
      box_2d: [200, 100, 270, 520],
      confidence: 0.93,
    })
    const lhs = makeFinding({
      detected_text: '∫ 2x dx',
      correction_text: '∫ 2x dx = x^2 + C',
      explanation: 'Evaluating the integral of 2x gives x^2 + C rather than x^3 + C.',
      spoken_alert: 'Integral of 2x evaluates to x squared plus C.',
      box_2d: [204, 102, 266, 300],
      confidence: 0.91,
    })
    const rhs = makeFinding({
      detected_text: 'x^3 + C',
      correction_text: 'x^2 + C',
      explanation: 'The antiderivative of 2x is x^2 + C, not x^3 + C.',
      spoken_alert: 'Right-hand side should be x squared plus C.',
      box_2d: [204, 345, 266, 515],
      confidence: 0.92,
    })

    const consolidated = deduplicateFindings([fullEq, lhs, rhs])
    expect(consolidated).toHaveLength(1)
    expect(consolidated[0]?.detected_text).toBe('x^3 + C')
    expect(consolidated[0]?.box_2d).toEqual([204, 345, 266, 515])
  })

  it('preserves genuinely distinct mistakes in the same equation or nearby region', () => {
    // Two distinct errors on the same equation line: ∫ 2x dx + d/dx(sin x) = x^3 - cos x
    const errIntegral = makeFinding({
      detected_text: 'x^3',
      correction_text: 'x^2',
      explanation: 'Integral of 2x is x^2, not x^3.',
      spoken_alert: 'Integral of 2x should be x squared.',
      box_2d: [200, 410, 265, 475],
    })
    const errDeriv = makeFinding({
      detected_text: '- cos x',
      correction_text: '+ cos x',
      explanation: 'Derivative of sin x is positive cos x.',
      spoken_alert: 'Derivative of sine x is plus cosine x.',
      box_2d: [200, 485, 265, 610],
    })

    const keptSameLine = deduplicateFindings([errIntegral, errDeriv])
    expect(keptSameLine).toHaveLength(2)

    // Distinct sign error and unit error even when one box encloses the other
    const errSign = makeFinding({
      category: 'physics',
      detected_text: 'v = u - at = 10 m',
      correction_text: 'v = u + at = 10 m',
      explanation: 'Kinematics uses +at for positive acceleration.',
      spoken_alert: 'Velocity formula uses plus a t.',
      box_2d: [400, 120, 470, 560],
    })
    const errUnit = makeFinding({
      category: 'physics',
      detected_text: '10 m',
      correction_text: '10 m/s',
      explanation: 'Velocity must have units of meters per second.',
      spoken_alert: 'Velocity unit should be meters per second.',
      box_2d: [406, 460, 466, 555],
    })

    const keptNested = deduplicateFindings([errSign, errUnit])
    expect(keptNested).toHaveLength(2)
  })

  it('consolidates cross-frame granularity shifts in-place and prefers the tighter box', () => {
    const s0 = createInitialTrackerState()
    const fullEq = makeFinding({
      detected_text: '∫ 2x dx = x^3 + C',
      correction_text: '∫ 2x dx = x^2 + C',
      explanation: 'Antiderivative of 2x is x^2 + C.',
      box_2d: [200, 100, 270, 520],
    })
    const rhs = makeFinding({
      detected_text: 'x^3 + C',
      correction_text: 'x^2 + C',
      explanation: 'Antiderivative of 2x is x^2 + C.',
      box_2d: [205, 345, 265, 515],
    })

    // Frame 1 detects full equation; Frame 2 narrows to RHS -> same ID, tightened box
    const r1 = reconcileAnalysis(s0, [fullEq], {
      sample: DUMMY_SAMPLE,
      classify: () => 'unchanged',
      relaxSpatial: false,
    })
    const id = r1.newlyOpened[0]!.id
    const r2 = reconcileAnalysis(r1.nextState, [rhs], {
      sample: DUMMY_SAMPLE,
      classify: () => 'unchanged',
      relaxSpatial: false,
    })
    expect(r2.newlyOpened).toHaveLength(0)
    expect(r2.nextState.issues).toHaveLength(1)
    expect(r2.nextState.issues[0]?.id).toBe(id)
    expect(r2.nextState.issues[0]?.box_2d).toEqual(rhs.box_2d)

    // Frame 3 widens back to full equation -> same ID, preserves tighter existing box
    const r3 = reconcileAnalysis(r2.nextState, [fullEq], {
      sample: DUMMY_SAMPLE,
      classify: () => 'unchanged',
      relaxSpatial: false,
    })
    expect(r3.newlyOpened).toHaveLength(0)
    expect(r3.nextState.issues).toHaveLength(1)
    expect(r3.nextState.issues[0]?.id).toBe(id)
    expect(r3.nextState.issues[0]?.box_2d).toEqual(rhs.box_2d)
  })

  it('preserves IDs across box jitter while keeping identical text at distinct locations separate', () => {
    const s0 = createInitialTrackerState()
    const r1 = reconcileAnalysis(s0, [makeFinding()], {
      sample: DUMMY_SAMPLE,
      classify: () => 'unchanged',
      relaxSpatial: false,
    })
    expect(r1.newlyOpened).toHaveLength(1)
    const id1 = r1.newlyOpened[0]!.id

    const r2 = reconcileAnalysis(
      r1.nextState,
      [makeFinding({ box_2d: [108, 110, 208, 430] })],
      { sample: DUMMY_SAMPLE, classify: () => 'unchanged', relaxSpatial: false },
    )
    expect(r2.newlyOpened).toHaveLength(0)
    const openIssues = r2.nextState.issues.filter((i) => i.status === 'open')
    expect(openIssues).toHaveLength(1)
    expect(openIssues[0]?.id).toBe(id1)

    const r3 = reconcileAnalysis(
      r2.nextState,
      [
        makeFinding({ box_2d: [108, 110, 208, 430] }),
        makeFinding({ box_2d: [700, 600, 800, 920] }),
      ],
      { sample: DUMMY_SAMPLE, classify: () => 'unchanged', relaxSpatial: false },
    )
    expect(r3.newlyOpened).toHaveLength(1)
    const openIds = r3.nextState.issues.filter((i) => i.status === 'open').map((i) => i.id)
    expect(new Set(openIds).size).toBe(2)
  })

  it('supports Tier 3 in-place revision on open issues without matching dismissed distinct signs', () => {
    expect(normalizeDetectedText('  x^2 − 4  ')).toBe('x^2 - 4')

    const s0 = createInitialTrackerState()
    const r1 = reconcileAnalysis(
      s0,
      [makeFinding({ detected_text: 'd/dx(x^3) = 2x^2', correction_text: 'd/dx(x^3) = 3x^2' })],
      { sample: DUMMY_SAMPLE, classify: () => 'unchanged', relaxSpatial: false },
    )
    const id = r1.newlyOpened[0]!.id

    const r2 = reconcileAnalysis(
      r1.nextState,
      [makeFinding({ detected_text: 'd/dx(x^3) = 4x^2', correction_text: 'd/dx(x^3) = 3x^2' })],
      { sample: DUMMY_SAMPLE, classify: () => 'changed', relaxSpatial: false },
    )
    expect(r2.newlyOpened).toHaveLength(0)
    expect(r2.nextState.issues[0]?.id).toBe(id)
    expect(r2.nextState.issues[0]?.detected_text).toBe('d/dx(x^3) = 4x^2')

    const sd = reconcileAnalysis(
      createInitialTrackerState(),
      [
        makeFinding({
          detected_text: 'x^2 + 4 = 0',
          correction_text: 'x = ±2i',
          explanation: 'Sum of squares has imaginary roots.',
          spoken_alert: 'Roots are imaginary.',
        }),
      ],
      { sample: DUMMY_SAMPLE, classify: () => 'unchanged', relaxSpatial: false },
    )
    const dismissed = dismissIssue(sd.nextState, sd.newlyOpened[0]!.id)
    const rSign = reconcileAnalysis(
      dismissed,
      [
        makeFinding({
          detected_text: 'x^2 - 4 = 0',
          correction_text: 'x = ±2',
          explanation: 'Difference of squares factors into (x-2)(x+2).',
          spoken_alert: 'Roots are plus or minus two.',
        }),
      ],
      { sample: DUMMY_SAMPLE, classify: () => 'changed', relaxSpatial: false },
    )
    expect(rSign.newlyOpened).toHaveLength(1)
  })

  it('auto-resolves changed fixes immediately, protects single unchanged/obscured misses, and resolves slide shifts', () => {
    const s0 = createInitialTrackerState()
    const r1 = reconcileAnalysis(s0, [makeFinding()], {
      sample: DUMMY_SAMPLE,
      classify: () => 'unchanged',
      relaxSpatial: false,
    })
    const id = r1.newlyOpened[0]!.id

    // Obscured misses NEVER increment missCount, but mark needsRecheck so monitor verifies once calm
    let cur = r1.nextState
    for (let k = 0; k < 4; k++) {
      cur = reconcileAnalysis(cur, [], {
        sample: DUMMY_SAMPLE,
        classify: () => 'obscured',
        relaxSpatial: false,
      }).nextState
      const item = cur.issues.find((i) => i.id === id)
      expect(item?.status).toBe('open')
      expect(item?.missCount).toBe(0)
      expect(item?.needsRecheck).toBe(true)
    }
    expect(getIssuesPendingRecheck(cur)).toHaveLength(1)

    // Unchanged calm region holds open on 1st miss, resolves on 2nd miss
    for (let k = 1; k < MISSES_TO_RESOLVE_UNCHANGED; k++) {
      cur = reconcileAnalysis(cur, [], {
        sample: DUMMY_SAMPLE,
        classify: () => 'unchanged',
        relaxSpatial: false,
      }).nextState
      expect(cur.issues.find((i) => i.id === id)?.status).toBe('open')
      expect(getIssuesPendingRecheck(cur)).toHaveLength(1)
    }
    cur = reconcileAnalysis(cur, [], {
      sample: DUMMY_SAMPLE,
      classify: () => 'unchanged',
      relaxSpatial: false,
    }).nextState
    expect(cur.issues.find((i) => i.id === id)?.status).toBe('resolved')
    expect(getIssuesPendingRecheck(cur)).toHaveLength(0)

    // Reappearing after resolution reopens silently (not in newlyOpened)
    const reopened = reconcileAnalysis(cur, [makeFinding()], {
      sample: DUMMY_SAMPLE,
      classify: () => 'unchanged',
      relaxSpatial: false,
    })
    expect(reopened.newlyOpened).toHaveLength(0)
    expect(reopened.nextState.issues.find((i) => i.id === id)?.status).toBe('open')

    // Calm changed region resolves immediately on MISSES_TO_RESOLVE_CHANGED (1) miss
    let changedCur = reopened.nextState
    for (let k = 0; k < MISSES_TO_RESOLVE_CHANGED; k++) {
      changedCur = reconcileAnalysis(changedCur, [], {
        sample: DUMMY_SAMPLE,
        classify: () => 'changed',
        relaxSpatial: false,
      }).nextState
    }
    expect(changedCur.issues.find((i) => i.id === id)?.status).toBe('resolved')

    // Scene shift (slide change) resolves unmatched old-slide issue after 2 calm misses
    const slide1 = reconcileAnalysis(createInitialTrackerState(), [makeFinding()], {
      sample: DUMMY_SAMPLE,
      classify: () => 'unchanged',
      relaxSpatial: false,
    })
    const slide2a = reconcileAnalysis(slide1.nextState, [], {
      sample: DUMMY_SAMPLE,
      classify: () => 'changed',
      relaxSpatial: true,
    })
    expect(slide2a.nextState.issues[0]?.status).toBe('open')
    expect(getIssuesPendingRecheck(slide2a.nextState)).toHaveLength(1)
    const slide2b = reconcileAnalysis(slide2a.nextState, [], {
      sample: DUMMY_SAMPLE,
      classify: () => 'unchanged',
      relaxSpatial: false,
    })
    expect(slide2b.nextState.issues[0]?.status).toBe('resolved')
  })

  it('handles Mark Fixed verification, scene-shift rematching, and dismiss undo/restore', () => {
    const s0 = createInitialTrackerState()
    const r1 = reconcileAnalysis(s0, [makeFinding()], {
      sample: DUMMY_SAMPLE,
      classify: () => 'unchanged',
      relaxSpatial: false,
    })
    const id = r1.newlyOpened[0]!.id

    const v1 = requestVerification(r1.nextState, id)
    const still = reconcileAnalysis(v1, [makeFinding()], {
      sample: DUMMY_SAMPLE,
      classify: () => 'unchanged',
      relaxSpatial: false,
    })
    expect(still.verifiedStillPresent).toHaveLength(1)
    expect(still.nextState.issues.find((i) => i.id === id)?.status).toBe('open')

    const v2 = requestVerification(still.nextState, id)
    const gone = reconcileAnalysis(v2, [], {
      sample: DUMMY_SAMPLE,
      classify: (): RegionStatus => 'changed',
      relaxSpatial: false,
    })
    expect(gone.verifiedResolved).toHaveLength(1)
    expect(gone.nextState.issues.find((i) => i.id === id)?.status).toBe('resolved')

    // relaxSpatial rematches identical finding even if camera panned across the board
    const shifted = reconcileAnalysis(
      r1.nextState,
      [makeFinding({ box_2d: [600, 600, 700, 920] })],
      { sample: DUMMY_SAMPLE, classify: () => 'changed', relaxSpatial: true },
    )
    expect(shifted.newlyOpened).toHaveLength(0)
    expect(shifted.nextState.issues[0]?.id).toBe(id)
    expect(shifted.nextState.issues[0]?.box_2d).toEqual([600, 600, 700, 920])

    const d1 = dismissIssue(shifted.nextState, id)
    expect(d1.issues[0]?.status).toBe('dismissed')
    const undone = undoLastDismissal(d1)
    expect(undone.issues[0]?.status).toBe('open')
    const d2 = dismissIssue(undone, id)
    const restored = resetDismissed(d2)
    expect(restored.issues[0]?.status).toBe('open')
  })

  it('resolves small edits in 1 miss, prevents cross-line box relocation, and omits relocating banner', () => {
    // 1. Small (~2%) sign/exponent edit inside a large box settles cleanly and classifies as 'changed'.
    const base: GrayscaleSample = {
      width: 160,
      height: 96,
      data: new Uint8Array(160 * 96).fill(30),
    }
    const modifiedData = new Uint8Array(base.data)
    // Box [200, 200, 400, 600] maps to x=32..96, y=19..39 (20*64 = 1280px).
    // Modify 28 pixels (~2.1% > 1.5% and < 4% old threshold).
    for (let x = 40; x < 68; x++) {
      modifiedData[28 * 160 + x] = 190
    }
    const modified: GrayscaleSample = { width: 160, height: 96, data: modifiedData }

    let detState = updateDetector(createDetectorState(), base, base, null).state
    detState = updateDetector(detState, modified, base, null).state
    detState = updateDetector(detState, modified, base, null).state
    const settled = updateDetector(detState, modified, base, null)
    // Simulate one boundary tile settling only 1 tick earlier while majority are calm (>= 2)
    const mixedTicks = new Uint16Array(settled.stillTicks)
    mixedTicks[Math.floor(20 / 16) * 10 + Math.floor(32 / 16)] = 1
    expect(
      classifyRegion([200, 200, 400, 600], base, modified, mixedTicks, null),
    ).toBe('changed')

    const r1 = reconcileAnalysis(createInitialTrackerState(), [makeFinding({ box_2d: [200, 200, 400, 600] })], {
      sample: base,
      classify: () => 'changed',
      relaxSpatial: false,
    })
    const openId = r1.newlyOpened[0]!.id
    const resolvedOnFirstMiss = reconcileAnalysis(r1.nextState, [], {
      sample: modified,
      classify: () => classifyRegion([200, 200, 400, 600], base, modified, mixedTicks, null),
      relaxSpatial: false,
    })
    expect(resolvedOnFirstMiss.nextState.issues.find((i) => i.id === openId)?.status).toBe(
      'resolved',
    )

    // 2. Non-overlapping conceptual match on the same line does not hijack/relocate an existing box via Tier 4.
    const eqLeft = makeFinding({
      detected_text: 'x^3 + C',
      correction_text: 'x^2 + C',
      explanation: 'The antiderivative of 2x is x^2 + C.',
      spoken_alert: 'Antiderivative of 2x is x squared plus C.',
      box_2d: [200, 100, 260, 260],
    })
    const eqRightNonOverlapping = makeFinding({
      detected_text: '∫ 2x dx',
      correction_text: '∫ 2x dx = x^2 + C',
      explanation: 'The antiderivative of 2x is x^2 + C.',
      spoken_alert: 'Integral of 2x equals x squared plus C.',
      box_2d: [200, 420, 260, 680],
    })
    const sLeft = reconcileAnalysis(createInitialTrackerState(), [eqLeft], {
      sample: DUMMY_SAMPLE,
      classify: () => 'unchanged',
      relaxSpatial: false,
    })
    const afterNonOverlap = reconcileAnalysis(sLeft.nextState, [eqRightNonOverlapping], {
      sample: DUMMY_SAMPLE,
      classify: () => 'unchanged',
      relaxSpatial: false,
    })
    const originalIssue = afterNonOverlap.nextState.issues.find(
      (i) => i.id === sLeft.newlyOpened[0]!.id,
    )
    expect(originalIssue?.box_2d).toEqual([200, 100, 260, 260])
  })

  it('treats re-occurring mistakes after an edit resolution as fresh unspoken issues while preserving spoken state across unchanged flicker', () => {
    const baseState = reconcileAnalysis(
      createInitialTrackerState(),
      [makeFinding({ detected_text: 'x^2 + 5 = 0', box_2d: [200, 200, 320, 460] })],
      { sample: DUMMY_SAMPLE, classify: () => 'unchanged', relaxSpatial: false },
    )
    const firstId = baseState.newlyOpened[0]!.id
    const spokenState = markIssueSpoken(baseState.nextState, firstId)

    // Resolved by an actual board edit (changed region miss)
    const resolvedByEdit = reconcileAnalysis(spokenState, [], {
      sample: DUMMY_SAMPLE,
      classify: () => 'changed',
      relaxSpatial: false,
    })
    expect(resolvedByEdit.nextState.issues.find((i) => i.id === firstId)?.resolvedByEdit).toBe(true)

    // Same mistake re-written later emits a brand-new ID with spoken=false in newlyOpened
    const rewrittenLater = reconcileAnalysis(
      resolvedByEdit.nextState,
      [makeFinding({ detected_text: 'x^2 + 5 = 0', box_2d: [200, 200, 320, 460] })],
      { sample: DUMMY_SAMPLE, classify: () => 'changed', relaxSpatial: false },
    )
    expect(rewrittenLater.newlyOpened).toHaveLength(1)
    expect(rewrittenLater.newlyOpened[0]!.id).not.toBe(firstId)
    expect(rewrittenLater.newlyOpened[0]!.spoken).toBe(false)

    // Contrast: resolved silently after 2 unchanged misses -> re-appearing keeps ID & spoken=true
    const unchangedBase = reconcileAnalysis(
      createInitialTrackerState(),
      [makeFinding({ detected_text: 'F = ma^2', box_2d: [500, 200, 620, 460] })],
      { sample: DUMMY_SAMPLE, classify: () => 'unchanged', relaxSpatial: false },
    )
    const unchangedId = unchangedBase.newlyOpened[0]!.id
    const spokenUnchanged = markIssueSpoken(unchangedBase.nextState, unchangedId)
    const miss1 = reconcileAnalysis(spokenUnchanged, [], {
      sample: DUMMY_SAMPLE,
      classify: () => 'unchanged',
      relaxSpatial: false,
    })
    const miss2 = reconcileAnalysis(miss1.nextState, [], {
      sample: DUMMY_SAMPLE,
      classify: () => 'unchanged',
      relaxSpatial: false,
    })
    expect(miss2.nextState.issues.find((i) => i.id === unchangedId)?.status).toBe('resolved')
    expect(miss2.nextState.issues.find((i) => i.id === unchangedId)?.resolvedByEdit).toBe(false)

    const reappeared = reconcileAnalysis(
      miss2.nextState,
      [makeFinding({ detected_text: 'F = ma^2', box_2d: [500, 200, 620, 460] })],
      { sample: DUMMY_SAMPLE, classify: () => 'unchanged', relaxSpatial: false },
    )
    expect(reappeared.newlyOpened).toHaveLength(0)
    const sameIssue = reappeared.nextState.issues.find((i) => i.id === unchangedId)
    expect(sameIssue?.status).toBe('open')
    expect(sameIssue?.spoken).toBe(true)
  })
})
