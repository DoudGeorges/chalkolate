import { Box2D, ErrorCategory, SourceSpaceDetectedError } from '../api/schemas'

export type IssueLifecycleStatus =
  | 'active'
  | 'dismissed'
  | 'verifying'
  | 'no_longer_detected'
  | 'inactive'

export interface TrackedIssue {
  id: string
  category: ErrorCategory
  detected_text: string
  normalized_text: string
  correction_text: string
  correction_latex: string | null
  spoken_alert: string
  explanation: string
  box_2d: Box2D
  confidence: number
  status: IssueLifecycleStatus
  firstSeenSeq: number
  lastSeenSeq: number
  spoken: boolean
}

export interface IssueTrackerState {
  analysisSeq: number
  issues: TrackedIssue[]
  dismissalHistoryIds: string[]
}

/**
 * Spatial matching thresholds tolerate small camera/bounding-box jitter while keeping
 * identical text written at distinct board regions separate.
 */
export const MATCH_MIN_IOU = 0.25
export const MATCH_MAX_CENTER_DIST = 65
export const MAX_TRACKED_HISTORY = 120

export function createInitialTrackerState(): IssueTrackerState {
  return {
    analysisSeq: 0,
    issues: [],
    dismissalHistoryIds: [],
  }
}

/**
 * Conservative normalization preserving mathematical case, signs, digits, exponents, and units.
 */
export function normalizeDetectedText(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/\u2212/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
}

export function computeBoxIoU(a: Box2D, b: Box2D): number {
  const interYMin = Math.max(a[0], b[0])
  const interXMin = Math.max(a[1], b[1])
  const interYMax = Math.min(a[2], b[2])
  const interXMax = Math.min(a[3], b[3])

  const interW = Math.max(0, interXMax - interXMin)
  const interH = Math.max(0, interYMax - interYMin)
  const interArea = interW * interH
  if (interArea <= 0) return 0

  const areaA = (a[2] - a[0]) * (a[3] - a[1])
  const areaB = (b[2] - b[0]) * (b[3] - b[1])
  const unionArea = areaA + areaB - interArea
  if (unionArea <= 0) return 0
  return interArea / unionArea
}

export function computeBoxCenterDistance(a: Box2D, b: Box2D): number {
  const cyA = (a[0] + a[2]) / 2
  const cxA = (a[1] + a[3]) / 2
  const cyB = (b[0] + b[2]) / 2
  const cxB = (b[1] + b[3]) / 2
  return Math.hypot(cxA - cxB, cyA - cyB)
}

function isSpatialMatch(a: Box2D, b: Box2D): { matched: boolean; score: number } {
  const iou = computeBoxIoU(a, b)
  const dist = computeBoxCenterDistance(a, b)
  if (iou >= MATCH_MIN_IOU || dist <= MATCH_MAX_CENTER_DIST) {
    // Higher IoU and smaller center distance rank better.
    return { matched: true, score: iou * 1000 - dist }
  }
  return { matched: false, score: Number.NEGATIVE_INFINITY }
}

function generateLocalUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `issue-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
}

export function reconcileAnalysis(
  state: IssueTrackerState,
  findings: readonly SourceSpaceDetectedError[],
): {
  nextState: IssueTrackerState
  newlyActivatedIssues: TrackedIssue[]
  reopenedIssues: TrackedIssue[]
} {
  const nextSeq = state.analysisSeq + 1
  const normalizedFindings = findings.map((finding, idx) => ({
    finding,
    idx,
    normalizedText: normalizeDetectedText(finding.detected_text),
  }))

  // Build deterministic candidate pairs sorted by best spatial match score, then index.
  const candidates: Array<{
    issueIndex: number
    findingIndex: number
    score: number
  }> = []

  for (let i = 0; i < state.issues.length; i++) {
    const existing = state.issues[i]!
    for (let j = 0; j < normalizedFindings.length; j++) {
      const f = normalizedFindings[j]!
      if (existing.category !== f.finding.category) continue
      if (existing.normalized_text !== f.normalizedText) continue
      const spatial = isSpatialMatch(existing.box_2d, f.finding.box_2d)
      if (spatial.matched) {
        candidates.push({ issueIndex: i, findingIndex: j, score: spatial.score })
      }
    }
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (a.findingIndex !== b.findingIndex) return a.findingIndex - b.findingIndex
    return a.issueIndex - b.issueIndex
  })

  const matchedIssueToFinding = new Map<number, number>()
  const matchedFindingIndices = new Set<number>()

  for (const candidate of candidates) {
    if (
      matchedIssueToFinding.has(candidate.issueIndex) ||
      matchedFindingIndices.has(candidate.findingIndex)
    ) {
      continue
    }
    matchedIssueToFinding.set(candidate.issueIndex, candidate.findingIndex)
    matchedFindingIndices.add(candidate.findingIndex)
  }

  const nextIssues: TrackedIssue[] = []
  const newlyActivatedIssues: TrackedIssue[] = []
  const reopenedIssues: TrackedIssue[] = []

  for (let i = 0; i < state.issues.length; i++) {
    const existing = state.issues[i]!
    const findingIdx = matchedIssueToFinding.get(i)

    if (findingIdx !== undefined) {
      const { finding, normalizedText } = normalizedFindings[findingIdx]!
      const nextStatus: IssueLifecycleStatus =
        existing.status === 'dismissed' ? 'dismissed' : 'active'

      const updated: TrackedIssue = {
        ...existing,
        detected_text: finding.detected_text,
        normalized_text: normalizedText,
        correction_text: finding.correction_text,
        correction_latex: finding.correction_latex,
        spoken_alert: finding.spoken_alert,
        explanation: finding.explanation,
        box_2d: finding.box_2d,
        confidence: finding.confidence,
        status: nextStatus,
        lastSeenSeq: nextSeq,
      }
      nextIssues.push(updated)
      if (existing.status === 'verifying') {
        reopenedIssues.push(updated)
      }
    } else {
      // Existing occurrence was not observed in this snapshot.
      let nextStatus: IssueLifecycleStatus = existing.status
      if (existing.status === 'verifying') {
        nextStatus = 'no_longer_detected'
      } else if (existing.status === 'active') {
        nextStatus = 'inactive'
      }
      nextIssues.push({
        ...existing,
        status: nextStatus,
      })
    }
  }

  for (let j = 0; j < normalizedFindings.length; j++) {
    if (matchedFindingIndices.has(j)) continue
    const { finding, normalizedText } = normalizedFindings[j]!
    const created: TrackedIssue = {
      id: generateLocalUuid(),
      category: finding.category,
      detected_text: finding.detected_text,
      normalized_text: normalizedText,
      correction_text: finding.correction_text,
      correction_latex: finding.correction_latex,
      spoken_alert: finding.spoken_alert,
      explanation: finding.explanation,
      box_2d: finding.box_2d,
      confidence: finding.confidence,
      status: 'active',
      firstSeenSeq: nextSeq,
      lastSeenSeq: nextSeq,
      spoken: false,
    }
    nextIssues.push(created)
    newlyActivatedIssues.push(created)
  }

  // Bound inactive/resolved history so memory never grows without bound.
  const pruned = pruneBoundedHistory(nextIssues)
  const keptIds = new Set(pruned.map((item) => item.id))

  return {
    nextState: {
      analysisSeq: nextSeq,
      issues: pruned,
      dismissalHistoryIds: state.dismissalHistoryIds.filter((id) => keptIds.has(id)),
    },
    newlyActivatedIssues,
    reopenedIssues,
  }
}

function pruneBoundedHistory(issues: TrackedIssue[]): TrackedIssue[] {
  if (issues.length <= MAX_TRACKED_HISTORY) return issues
  const activeOrLive = issues.filter(
    (item) =>
      item.status === 'active' ||
      item.status === 'verifying' ||
      item.status === 'no_longer_detected' ||
      item.status === 'dismissed',
  )
  const inactive = issues
    .filter((item) => item.status === 'inactive')
    .sort((a, b) => b.lastSeenSeq - a.lastSeenSeq)

  const remainingSlots = Math.max(0, MAX_TRACKED_HISTORY - activeOrLive.length)
  const combined = [...activeOrLive, ...inactive.slice(0, remainingSlots)]
  if (combined.length <= MAX_TRACKED_HISTORY) return combined

  // If even dismissed + live exceeds MAX_TRACKED_HISTORY, retain newest by lastSeenSeq.
  return [...combined]
    .sort((a, b) => {
      const aLive = a.status === 'active' || a.status === 'verifying' ? 1 : 0
      const bLive = b.status === 'active' || b.status === 'verifying' ? 1 : 0
      if (aLive !== bLive) return bLive - aLive
      return b.lastSeenSeq - a.lastSeenSeq
    })
    .slice(0, MAX_TRACKED_HISTORY)
}

export function markIssueSpoken(state: IssueTrackerState, issueId: string): IssueTrackerState {
  return {
    ...state,
    issues: state.issues.map((issue) =>
      issue.id === issueId ? { ...issue, spoken: true } : issue,
    ),
  }
}

export function dismissIssue(state: IssueTrackerState, issueId: string): IssueTrackerState {
  const target = state.issues.find((item) => item.id === issueId)
  if (!target || target.status === 'dismissed') return state
  return {
    ...state,
    issues: state.issues.map((issue) =>
      issue.id === issueId ? { ...issue, status: 'dismissed' } : issue,
    ),
    dismissalHistoryIds: [...state.dismissalHistoryIds.filter((id) => id !== issueId), issueId],
  }
}

export function undoLastDismissal(state: IssueTrackerState): IssueTrackerState {
  if (state.dismissalHistoryIds.length === 0) return state
  const targetId = state.dismissalHistoryIds[state.dismissalHistoryIds.length - 1]
  return {
    ...state,
    issues: state.issues.map((issue) => {
      if (issue.id !== targetId) return issue
      const restoredStatus: IssueLifecycleStatus =
        issue.lastSeenSeq === state.analysisSeq ? 'active' : 'inactive'
      return { ...issue, status: restoredStatus }
    }),
    dismissalHistoryIds: state.dismissalHistoryIds.slice(0, -1),
  }
}

export function resetDismissed(state: IssueTrackerState): IssueTrackerState {
  if (state.dismissalHistoryIds.length === 0) return state
  return {
    ...state,
    issues: state.issues.map((issue) => {
      if (issue.status !== 'dismissed') return issue
      const restoredStatus: IssueLifecycleStatus =
        issue.lastSeenSeq === state.analysisSeq ? 'active' : 'inactive'
      return { ...issue, status: restoredStatus }
    }),
    dismissalHistoryIds: [],
  }
}

export function markIssueVerifying(state: IssueTrackerState, issueId: string): IssueTrackerState {
  return {
    ...state,
    issues: state.issues.map((issue) =>
      issue.id === issueId && issue.status === 'active'
        ? { ...issue, status: 'verifying' }
        : issue,
    ),
  }
}

export function revertVerifyingOnFailure(state: IssueTrackerState): IssueTrackerState {
  return {
    ...state,
    issues: state.issues.map((issue) =>
      issue.status === 'verifying' ? { ...issue, status: 'active' } : issue,
    ),
  }
}

export function clearNoLongerDetected(
  state: IssueTrackerState,
  issueId: string,
): IssueTrackerState {
  return {
    ...state,
    issues: state.issues.map((issue) =>
      issue.id === issueId && issue.status === 'no_longer_detected'
        ? { ...issue, status: 'inactive' }
        : issue,
    ),
  }
}
