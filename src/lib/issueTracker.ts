import { Box2D, ErrorCategory, SourceSpaceDetectedError } from '../api/schemas'
import { RegionStatus } from './changeDetector'
import { GrayscaleSample } from './frameCapture'

export type IssueLifecycleStatus = 'open' | 'dismissed' | 'resolved'

export interface TrackedIssue {
  id: string
  category: ErrorCategory
  detected_text: string
  normalized_text: string
  compact_text: string
  correction_text: string
  correction_latex: string | null
  spoken_alert: string
  explanation: string
  box_2d: Box2D
  confidence: number
  status: IssueLifecycleStatus
  missCount: number
  /** True when absent on a recent analysis while obscured or awaiting quiet re-verification. */
  needsRecheck: boolean
  firstSeenSeq: number
  lastSeenSeq: number
  lastSeenSample: GrayscaleSample | null
  spoken: boolean
  pendingVerification: boolean
}

export interface IssueTrackerState {
  analysisSeq: number
  issues: TrackedIssue[]
  dismissalHistoryIds: string[]
}

export interface ReconcileContext {
  sample: GrayscaleSample
  classify: (issue: TrackedIssue) => RegionStatus
  relaxSpatial: boolean
}

export interface ReconcileResult {
  nextState: IssueTrackerState
  newlyOpened: TrackedIssue[]
  verifiedResolved: TrackedIssue[]
  verifiedStillPresent: TrackedIssue[]
}

/**
 * Spatial matching thresholds tolerate moderate jitter across detections while
 * keeping identical writing at separate locations distinct.
 */
export const MATCH_MIN_IOU = 0.25
export const MATCH_MAX_CENTER_DIST = 65
export const REVISION_MIN_IOU = 0.5
export const REVISION_MIN_SIMILARITY = 0.6
export const MISSES_TO_RESOLVE_CHANGED = 1
export const MISSES_TO_RESOLVE_UNCHANGED = 2
export const MAX_TRACKED_HISTORY = 120

const WORD_CHAR = /[\p{L}\p{N}_]/u

export function createInitialTrackerState(): IssueTrackerState {
  return {
    analysisSeq: 0,
    issues: [],
    dismissalHistoryIds: [],
  }
}

/**
 * Conservative normalization preserving case, signs, digits, exponents, and units.
 */
export function normalizeDetectedText(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/\u2212/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
}

export function compactDetectedText(normalized: string): string {
  return normalized.replace(/[\u00d7\u22c5]/g, '*').replace(/\s+/g, '')
}

function boxArea(b: Box2D): number {
  return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1])
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

  const areaA = boxArea(a)
  const areaB = boxArea(b)
  const unionArea = areaA + areaB - interArea
  if (unionArea <= 0) return 0
  return interArea / unionArea
}

/** Fraction of the smaller bounding box enclosed inside the larger bounding box. */
export function computeBoxContainment(a: Box2D, b: Box2D): number {
  const interYMin = Math.max(a[0], b[0])
  const interXMin = Math.max(a[1], b[1])
  const interYMax = Math.min(a[2], b[2])
  const interXMax = Math.min(a[3], b[3])

  const interW = Math.max(0, interXMax - interXMin)
  const interH = Math.max(0, interYMax - interYMin)
  const interArea = interW * interH
  if (interArea <= 0) return 0

  const minArea = Math.min(boxArea(a), boxArea(b))
  if (minArea <= 0) return 0
  return interArea / minArea
}

export function computeBoxCenterDistance(a: Box2D, b: Box2D): number {
  const cyA = (a[0] + a[2]) / 2
  const cxA = (a[1] + a[3]) / 2
  const cyB = (b[0] + b[2]) / 2
  const cxB = (b[1] + b[3]) / 2
  return Math.hypot(cxA - cxB, cyA - cyB)
}

function sameLineAdjacent(a: Box2D, b: Box2D): boolean {
  const heightA = a[2] - a[0]
  const heightB = b[2] - b[0]
  const minHeight = Math.min(heightA, heightB)
  if (minHeight <= 0) return false

  const vOverlap = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
  if (vOverlap / minHeight < 0.5) return false

  const hGap = Math.max(0, Math.max(a[1], b[1]) - Math.min(a[3], b[3]))
  const maxWidth = Math.max(a[3] - a[1], b[3] - b[1])
  return hGap <= Math.max(80, 0.4 * maxWidth)
}

function levenshteinSimilarity(a: string, b: string): number {
  if (a === b) return 1
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 1

  const prev = new Array<number>(b.length + 1)
  const curr = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) {
    prev[j] = j
  }

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1
      const del = (prev[j] ?? 0) + 1
      const ins = (curr[j - 1] ?? 0) + 1
      const sub = (prev[j - 1] ?? 0) + cost
      curr[j] = Math.min(del, ins, sub)
    }
    for (let j = 0; j <= b.length; j++) {
      prev[j] = curr[j] ?? 0
    }
  }
  return 1 - (prev[b.length] ?? maxLen) / maxLen
}

function categoriesCompatible(a: ErrorCategory, b: ErrorCategory): boolean {
  if (a === b) return true
  return (a === 'math' && b === 'physics') || (a === 'physics' && b === 'math')
}

function containsNonTrivial(haystack: string, needle: string): boolean {
  if (needle.length < 2) return false
  for (let start = haystack.indexOf(needle); start !== -1; start = haystack.indexOf(needle, start + 1)) {
    const end = start + needle.length
    const cutsStart = WORD_CHAR.test(needle[0] ?? '') && WORD_CHAR.test(haystack[start - 1] ?? '')
    const cutsEnd = WORD_CHAR.test(needle.at(-1) ?? '') && WORD_CHAR.test(haystack[end] ?? '')
    if (!cutsStart && !cutsEnd) return true
  }
  return false
}

function eitherContains(a: string, b: string): boolean {
  return containsNonTrivial(a, b) || containsNonTrivial(b, a)
}

type FindingIdentity = Pick<SourceSpaceDetectedError, 'category' | 'box_2d' | 'detected_text' | 'correction_text'>

// A one-character sign or exponent can occur several times on the same line.
// Only equate the two spans when the local edit reproduces the corrected line.
function reproducesEdit(line: string, fixed: string, term: string, replacement: string): boolean {
  if (!term || term.length >= line.length) return false
  for (let at = line.indexOf(term); at >= 0; at = line.indexOf(term, at + 1)) {
    if (line.slice(0, at) + replacement + line.slice(at + term.length) === fixed) return true
  }
  return false
}

/**
 * Determines whether two findings describe the same conceptual mistake (e.g. a full
 * equation plus its erroneous RHS or LHS) while preserving genuinely distinct errors
 * that happen to share an equation or nearby region.
 */
export function areEquivalentFindings(
  a: FindingIdentity,
  b: FindingIdentity,
): boolean {
  if (!categoriesCompatible(a.category, b.category)) return false

  const detectedA = normalizeDetectedText(a.detected_text)
  const detectedB = normalizeDetectedText(b.detected_text)
  const correctionA = normalizeDetectedText(a.correction_text)
  const correctionB = normalizeDetectedText(b.correction_text)
  const sameCorrection = compactDetectedText(correctionA) === compactDetectedText(correctionB)
  const iou = computeBoxIoU(a.box_2d, b.box_2d)
  const containment = computeBoxContainment(a.box_2d, b.box_2d)

  // Overlapping or nested boxes (e.g. full equation enclosing wrong RHS or LHS).
  if (iou >= 0.45 || containment >= 0.65) {
    if (reproducesEdit(detectedA, correctionA, detectedB, correctionB) ||
        reproducesEdit(detectedB, correctionB, detectedA, correctionA)) return true
    const sameTarget = compactDetectedText(detectedA) === compactDetectedText(detectedB)
    return (sameTarget || eitherContains(detectedA, detectedB)) &&
      (sameCorrection || eitherContains(correctionA, correctionB))
  }

  // Same-line adjacent boxes (e.g. LHS and RHS of the same incorrect equation).
  if (sameCorrection && sameLineAdjacent(a.box_2d, b.box_2d)) {
    // Group duplicate equation sides only when one side is kept in their shared replacement.
    const aIsUnchangedSide = containsNonTrivial(correctionA, detectedA)
    const bIsUnchangedSide = containsNonTrivial(correctionB, detectedB)
    return aIsUnchangedSide !== bIsUnchangedSide
  }

  return false
}

function isUnchangedSideHighlight(finding: SourceSpaceDetectedError): boolean {
  const det = normalizeDetectedText(finding.detected_text)
  const cor = normalizeDetectedText(finding.correction_text)
  return cor.length > det.length && containsNonTrivial(cor, det)
}

function pickPreferredClusterFinding(
  cluster: readonly SourceSpaceDetectedError[],
): SourceSpaceDetectedError {
  if (cluster.length === 1) return cluster[0]!

  // Prefer findings targeting the actual erroneous side over unchanged LHS highlights.
  const actualErrors = cluster.filter((item) => !isUnchangedSideHighlight(item))
  const candidates = actualErrors.length > 0 ? actualErrors : cluster

  let best = candidates[0]!
  let bestArea = boxArea(best.box_2d)

  for (let i = 1; i < candidates.length; i++) {
    const cur = candidates[i]!
    const curArea = boxArea(cur.box_2d)
    // Prefer the tighter clear box; break near-ties (within 15% area) by higher confidence.
    if (curArea < bestArea * 0.85) {
      best = cur
      bestArea = curArea
    } else if (curArea <= bestArea * 1.15 && cur.confidence > best.confidence) {
      best = cur
      bestArea = curArea
    }
  }
  return best
}

/**
 * Consolidates intra-frame duplicate or overlapping findings describing the same
 * conceptual mistake into one finding with the smallest clear bounding box.
 */
export function deduplicateFindings(
  findings: readonly SourceSpaceDetectedError[],
): SourceSpaceDetectedError[] {
  if (findings.length <= 1) return [...findings]

  const clusters: SourceSpaceDetectedError[][] = []
  for (const finding of findings) {
    // A wide box can overlap several unrelated mistakes. Require each pair to agree.
    const cluster = clusters.find((items) => items.every((item) => areEquivalentFindings(item, finding)))
    if (cluster) cluster.push(finding)
    else clusters.push([finding])
  }
  return clusters.map(pickPreferredClusterFinding)
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
  ctx: ReconcileContext,
): ReconcileResult {
  const nextSeq = state.analysisSeq + 1
  const dedupedFindings = deduplicateFindings(findings)
  const preparedFindings = dedupedFindings.map((finding) => {
    const norm = normalizeDetectedText(finding.detected_text)
    return {
      finding,
      norm,
      compact: compactDetectedText(norm),
    }
  })

  // Tier 1: exact normalized text; Tier 2: compact text;
  // Tier 3: in-place open revision (IoU + Levenshtein);
  // Tier 4: conceptual equivalence on open/dismissed issues (consolidates box granularity drift).
  const candidates: Array<{
    issueIndex: number
    findingIndex: number
    tier: number
    score: number
  }> = []

  for (let i = 0; i < state.issues.length; i++) {
    const existing = state.issues[i]!
    for (let j = 0; j < preparedFindings.length; j++) {
      const f = preparedFindings[j]!

      if (existing.category === f.finding.category) {
        const iou = computeBoxIoU(existing.box_2d, f.finding.box_2d)
        const dist = computeBoxCenterDistance(existing.box_2d, f.finding.box_2d)
        const spatiallyClose = iou >= MATCH_MIN_IOU || dist <= MATCH_MAX_CENTER_DIST ||
          (existing.status === 'open' && existing.correction_text === f.finding.correction_text &&
            computeBoxContainment(existing.box_2d, f.finding.box_2d) >= 0.85)

        if (existing.normalized_text === f.norm) {
          if (ctx.relaxSpatial || spatiallyClose) {
            candidates.push({
              issueIndex: i,
              findingIndex: j,
              tier: 1,
              score: ctx.relaxSpatial ? -dist : iou * 1000 - dist,
            })
          }
          continue
        }

        if (existing.compact_text === f.compact) {
          if (ctx.relaxSpatial || spatiallyClose) {
            candidates.push({
              issueIndex: i,
              findingIndex: j,
              tier: 2,
              score: ctx.relaxSpatial ? -dist : iou * 1000 - dist,
            })
          }
          continue
        }

        // Tier 3 applies strictly to currently open issues (never dismissed/resolved).
        if (existing.status === 'open' && iou >= REVISION_MIN_IOU) {
          const sim = levenshteinSimilarity(existing.compact_text, f.compact)
          if (sim >= REVISION_MIN_SIMILARITY) {
            candidates.push({
              issueIndex: i,
              findingIndex: j,
              tier: 3,
              score: sim * 1000 + iou * 100,
            })
            continue
          }
        }
      }

      // Tier 4 matches conceptually equivalent overlapping findings across box granularity shifts
      // (e.g. full equation <-> erroneous RHS) strictly for currently open issues.
      if (existing.status === 'open' && areEquivalentFindings(existing, f.finding)) {
        const iou = computeBoxIoU(existing.box_2d, f.finding.box_2d)
        const containment = computeBoxContainment(existing.box_2d, f.finding.box_2d)
        if (iou >= MATCH_MIN_IOU || containment >= 0.6) {
          candidates.push({
            issueIndex: i,
            findingIndex: j,
            tier: 4,
            score: containment * 500 + iou * 500,
          })
        }
      }
    }
  }

  candidates.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier
    if (b.score !== a.score) return b.score - a.score
    if (a.findingIndex !== b.findingIndex) return a.findingIndex - b.findingIndex
    return a.issueIndex - b.issueIndex
  })

  const matchedIssueToMatch = new Map<number, { findingIndex: number; tier: number }>()
  const matchedFindingIndices = new Set<number>()

  for (const c of candidates) {
    if (matchedIssueToMatch.has(c.issueIndex) || matchedFindingIndices.has(c.findingIndex)) {
      continue
    }
    matchedIssueToMatch.set(c.issueIndex, { findingIndex: c.findingIndex, tier: c.tier })
    matchedFindingIndices.add(c.findingIndex)
  }

  const nextIssues: TrackedIssue[] = []
  const newlyOpened: TrackedIssue[] = []
  const verifiedResolved: TrackedIssue[] = []
  const verifiedStillPresent: TrackedIssue[] = []

  for (let i = 0; i < state.issues.length; i++) {
    const existing = state.issues[i]!
    const match = matchedIssueToMatch.get(i)

    if (match !== undefined) {
      const f = preparedFindings[match.findingIndex]!
      const nextStatus: IssueLifecycleStatus =
        existing.status === 'dismissed' ? 'dismissed' : 'open'

      // Preserve a verified term box if the model later encloses it in the whole line.
      const keepTighterExistingBox =
        match.tier !== 3 &&
        existing.status === 'open' &&
        !ctx.relaxSpatial &&
        computeBoxContainment(existing.box_2d, f.finding.box_2d) >= 0.85 &&
        boxArea(existing.box_2d) < boxArea(f.finding.box_2d) * 0.75

      // On Tier 1/2 unchanged match, keep the existing box anchored unless the new box is
      // substantially tighter or shifted enough to represent a new position.
      const keepAnchoredBox =
        (match.tier === 1 || match.tier === 2) &&
        existing.status === 'open' &&
        !ctx.relaxSpatial &&
        computeBoxIoU(existing.box_2d, f.finding.box_2d) >= 0.65 &&
        boxArea(f.finding.box_2d) >= boxArea(existing.box_2d) * 0.85

      const keepTerm = keepTighterExistingBox && match.tier === 4
      const updated: TrackedIssue = {
        ...existing,
        category: f.finding.category,
        detected_text: keepTerm ? existing.detected_text : f.finding.detected_text,
        normalized_text: keepTerm ? existing.normalized_text : f.norm,
        compact_text: keepTerm ? existing.compact_text : f.compact,
        correction_text: keepTerm ? existing.correction_text : f.finding.correction_text,
        correction_latex: keepTerm ? existing.correction_latex : f.finding.correction_latex,
        spoken_alert: f.finding.spoken_alert,
        explanation: f.finding.explanation,
        box_2d: keepTighterExistingBox || keepAnchoredBox ? existing.box_2d : f.finding.box_2d,
        confidence: f.finding.confidence,
        status: nextStatus,
        missCount: 0,
        needsRecheck: false,
        lastSeenSeq: nextSeq,
        lastSeenSample: ctx.sample,
        pendingVerification: false,
      }

      nextIssues.push(updated)
      if (existing.pendingVerification) {
        verifiedStillPresent.push(updated)
      }
    } else if (existing.status === 'open') {
      const region = ctx.classify(existing)
      if (existing.pendingVerification) {
        if (ctx.relaxSpatial || region === 'obscured') {
          nextIssues.push({ ...existing, needsRecheck: true })
        } else {
          const resolved: TrackedIssue = {
            ...existing,
            status: 'resolved',
            missCount: existing.missCount + 1,
            needsRecheck: false,
            pendingVerification: false,
          }
          nextIssues.push(resolved)
          verifiedResolved.push(resolved)
        }
      } else if (region === 'obscured') {
        // Hold open while hand/presenter motion obscures the region; recheck once calm.
        nextIssues.push({ ...existing, needsRecheck: true })
      } else {
        const nextMiss = existing.missCount + 1
        // After a full scene shift (relaxSpatial), require two calm misses before resolving.
        const threshold =
          !ctx.relaxSpatial && region === 'changed'
            ? MISSES_TO_RESOLVE_CHANGED
            : MISSES_TO_RESOLVE_UNCHANGED
        const isResolved = nextMiss >= threshold
        nextIssues.push({
          ...existing,
          missCount: nextMiss,
          needsRecheck: !isResolved,
          status: isResolved ? 'resolved' : 'open',
        })
      }
    } else {
      nextIssues.push({
        ...existing,
        needsRecheck: false,
        pendingVerification: false,
      })
    }
  }

  for (let j = 0; j < preparedFindings.length; j++) {
    if (matchedFindingIndices.has(j)) continue
    const f = preparedFindings[j]!
    const created: TrackedIssue = {
      id: generateLocalUuid(),
      category: f.finding.category,
      detected_text: f.finding.detected_text,
      normalized_text: f.norm,
      compact_text: f.compact,
      correction_text: f.finding.correction_text,
      correction_latex: f.finding.correction_latex,
      spoken_alert: f.finding.spoken_alert,
      explanation: f.finding.explanation,
      box_2d: f.finding.box_2d,
      confidence: f.finding.confidence,
      status: 'open',
      missCount: 0,
      needsRecheck: false,
      firstSeenSeq: nextSeq,
      lastSeenSeq: nextSeq,
      lastSeenSample: ctx.sample,
      spoken: false,
      pendingVerification: false,
    }
    nextIssues.push(created)
    newlyOpened.push(created)
  }

  const pruned = pruneBoundedHistory(nextIssues)
  const keptIds = new Set(pruned.map((item) => item.id))

  return {
    nextState: {
      analysisSeq: nextSeq,
      issues: pruned,
      dismissalHistoryIds: state.dismissalHistoryIds.filter((id) => keptIds.has(id)),
    },
    newlyOpened,
    verifiedResolved,
    verifiedStillPresent,
  }
}

export function getIssuesPendingRecheck(state: IssueTrackerState): TrackedIssue[] {
  return state.issues.filter(
    (item) => item.status === 'open' && (item.missCount > 0 || item.needsRecheck),
  )
}

function pruneBoundedHistory(issues: TrackedIssue[]): TrackedIssue[] {
  if (issues.length <= MAX_TRACKED_HISTORY) return issues
  const open = issues.filter((item) => item.status === 'open')
  const dismissed = issues
    .filter((item) => item.status === 'dismissed')
    .sort((a, b) => b.lastSeenSeq - a.lastSeenSeq)
  const resolved = issues
    .filter((item) => item.status === 'resolved')
    .sort((a, b) => b.lastSeenSeq - a.lastSeenSeq)

  // Prune resolved (oldest lastSeenSeq) first, then oldest dismissed if still over limit.
  const keepAfterOpen = Math.max(0, MAX_TRACKED_HISTORY - open.length)
  const keptDismissed = dismissed.slice(0, keepAfterOpen)
  const remainingForResolved = Math.max(0, keepAfterOpen - keptDismissed.length)
  const keptResolved = resolved.slice(0, remainingForResolved)

  const combined = [...open, ...keptDismissed, ...keptResolved]
  return combined.slice(0, MAX_TRACKED_HISTORY)
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
      issue.id === issueId
        ? { ...issue, status: 'dismissed', needsRecheck: false, pendingVerification: false }
        : issue,
    ),
    dismissalHistoryIds: [...state.dismissalHistoryIds.filter((id) => id !== issueId), issueId],
  }
}

export function undoLastDismissal(state: IssueTrackerState): IssueTrackerState {
  if (state.dismissalHistoryIds.length === 0) return state
  const targetId = state.dismissalHistoryIds[state.dismissalHistoryIds.length - 1]
  return {
    ...state,
    issues: state.issues.map((issue) =>
      issue.id === targetId
        ? { ...issue, status: 'open', missCount: 0, needsRecheck: false }
        : issue,
    ),
    dismissalHistoryIds: state.dismissalHistoryIds.slice(0, -1),
  }
}

export function resetDismissed(state: IssueTrackerState): IssueTrackerState {
  if (state.dismissalHistoryIds.length === 0) return state
  return {
    ...state,
    issues: state.issues.map((issue) =>
      issue.status === 'dismissed'
        ? { ...issue, status: 'open', missCount: 0, needsRecheck: false }
        : issue,
    ),
    dismissalHistoryIds: [],
  }
}

export function requestVerification(state: IssueTrackerState, issueId: string): IssueTrackerState {
  return {
    ...state,
    issues: state.issues.map((issue) =>
      issue.id === issueId && issue.status === 'open'
        ? { ...issue, pendingVerification: true }
        : issue,
    ),
  }
}

export function clearPendingVerification(state: IssueTrackerState): IssueTrackerState {
  return {
    ...state,
    issues: state.issues.map((issue) =>
      issue.pendingVerification ? { ...issue, pendingVerification: false } : issue,
    ),
  }
}
