import { describe, expect, it } from 'vitest'
import { SourceSpaceDetectedError } from '../api/schemas'
import {
  createInitialTrackerState,
  dismissIssue,
  markIssueVerifying,
  normalizeDetectedText,
  reconcileAnalysis,
  resetDismissed,
  revertVerifyingOnFailure,
  undoLastDismissal,
} from '../lib/issueTracker'

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
    box_2d: [100, 100, 180, 420],
    confidence: 0.94,
    ...overrides,
  }
}

describe('Session-scoped issue tracker', () => {
  it('preserves IDs across box jitter while keeping distinct locations separate', () => {
    const s0 = createInitialTrackerState()
    const r1 = reconcileAnalysis(s0, [makeFinding()])
    expect(r1.newlyActivatedIssues).toHaveLength(1)
    const id1 = r1.newlyActivatedIssues[0]!.id

    // Small bounding box jitter (+8..12 units) preserves same local UUID
    const r2 = reconcileAnalysis(r1.nextState, [
      makeFinding({ box_2d: [108, 110, 190, 430] }),
    ])
    expect(r2.newlyActivatedIssues).toHaveLength(0)
    const activeAfterJitter = r2.nextState.issues.filter((i) => i.status === 'active')
    expect(activeAfterJitter).toHaveLength(1)
    expect(activeAfterJitter[0]?.id).toBe(id1)

    // Identical text written in a distinct region bottom-right receives a distinct ID
    const r3 = reconcileAnalysis(r2.nextState, [
      makeFinding({ box_2d: [108, 110, 190, 430] }),
      makeFinding({ box_2d: [700, 600, 780, 920] }),
    ])
    expect(r3.newlyActivatedIssues).toHaveLength(1)
    const activeIds = r3.nextState.issues
      .filter((i) => i.status === 'active')
      .map((i) => i.id)
    expect(new Set(activeIds).size).toBe(2)
  })

  it('preserves case, signs, exponents, and units during normalization', () => {
    expect(normalizeDetectedText('  x^2 − 4  ')).toBe('x^2 - 4')
    expect(normalizeDetectedText('x^2 + 4')).not.toBe(normalizeDetectedText('x^2 - 4'))
    expect(normalizeDetectedText('10 m/s')).not.toBe(normalizeDetectedText('10 m/s^2'))
    expect(normalizeDetectedText('F = ma')).not.toBe(normalizeDetectedText('f = ma'))

    const s0 = createInitialTrackerState()
    const r1 = reconcileAnalysis(s0, [makeFinding({ detected_text: 'x^2 + 4 = 0' })])
    const dismissed = dismissIssue(r1.nextState, r1.newlyActivatedIssues[0]!.id)

    // Materially different sign/text at the same spot is NOT suppressed by dismissal
    const r2 = reconcileAnalysis(dismissed, [makeFinding({ detected_text: 'x^2 - 4 = 0' })])
    expect(r2.newlyActivatedIssues).toHaveLength(1)
  })

  it('retains inactive history across missed frames and supports dismiss/undo/reset', () => {
    const s0 = createInitialTrackerState()
    const r1 = reconcileAnalysis(s0, [makeFinding()])
    const id = r1.newlyActivatedIssues[0]!.id

    // Missed detection moves issue to inactive without erasing ID
    const r2 = reconcileAnalysis(r1.nextState, [])
    expect(r2.nextState.issues.find((i) => i.id === id)?.status).toBe('inactive')

    // Reappearing finding reuses the same tracked ID instead of creating a duplicate alert
    const r3 = reconcileAnalysis(r2.nextState, [makeFinding()])
    expect(r3.newlyActivatedIssues).toHaveLength(0)
    expect(r3.nextState.issues.find((i) => i.id === id)?.status).toBe('active')

    // Dismiss -> stays suppressed when seen again -> Undo -> Reset
    const d1 = dismissIssue(r3.nextState, id)
    const r4 = reconcileAnalysis(d1, [makeFinding()])
    expect(r4.nextState.issues.find((i) => i.id === id)?.status).toBe('dismissed')
    expect(r4.newlyActivatedIssues).toHaveLength(0)

    const undone = undoLastDismissal(r4.nextState)
    expect(undone.issues.find((i) => i.id === id)?.status).toBe('active')

    const d2 = dismissIssue(undone, id)
    const reset = resetDismissed(d2)
    expect(reset.issues.find((i) => i.id === id)?.status).toBe('active')
  })

  it('handles Mark Fixed lifecycle for absent, persistent, and failed verification', () => {
    const s0 = createInitialTrackerState()
    const r1 = reconcileAnalysis(s0, [makeFinding()])
    const id = r1.newlyActivatedIssues[0]!.id

    const verifying = markIssueVerifying(r1.nextState, id)
    expect(verifying.issues.find((i) => i.id === id)?.status).toBe('verifying')

    // Failed recheck reverts verifying back to active (never marks resolved)
    const reverted = revertVerifyingOnFailure(verifying)
    expect(reverted.issues.find((i) => i.id === id)?.status).toBe('active')

    // Absent after successful recheck -> no_longer_detected
    const verifying2 = markIssueVerifying(reverted, id)
    const absent = reconcileAnalysis(verifying2, [])
    expect(absent.nextState.issues.find((i) => i.id === id)?.status).toBe(
      'no_longer_detected',
    )

    // Persistent issue after recheck -> reopened active
    const rStart = reconcileAnalysis(s0, [makeFinding()])
    const idB = rStart.newlyActivatedIssues[0]!.id
    const verB = markIssueVerifying(rStart.nextState, idB)
    const persisted = reconcileAnalysis(verB, [makeFinding()])
    expect(persisted.reopenedIssues).toHaveLength(1)
    expect(persisted.nextState.issues.find((i) => i.id === idB)?.status).toBe('active')
  })
})
