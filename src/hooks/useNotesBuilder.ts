import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiClientError, requestNotesUpdate } from '../api/client'
import { isAbortError } from '../lib/abort'
import { createRequestId } from '../lib/requestId'
import { Box2D, CalibrationCorners, NotesMetadataPayload, NotesResponse } from '../api/schemas'
import { DetectorState, createDetectorState, updateDetector } from '../lib/changeDetector'
import {
  GrayscaleSample,
  MediaFrameSource,
  captureJpegBlob,
  sampleGrayscaleFrame,
} from '../lib/frameCapture'
import { buildNormalizedQuadMask } from '../lib/geometry'
import {
  NotesDocument,
  applyNotesUpdate,
  buildNotesContext,
  createEmptyNotes,
  cropRect,
  loadNotes,
  purgeLegacyNotes,
  saveNotes,
} from '../lib/notes'
import {
  NOTES_CALM_MOVING_FRACTION,
  NOTES_CALM_TICKS,
  NOTES_SAMPLE_INTERVAL_MS,
  changedTileFraction,
  decideNotesAction,
} from '../lib/notesTrigger'

export type NotesPhase = 'idle' | 'watching' | 'building'

export interface NotesBuilderDeps {
  sampleFrame: (source: MediaFrameSource, canvas: HTMLCanvasElement) => GrayscaleSample | null
  captureSnapshot: (source: MediaFrameSource, canvas: HTMLCanvasElement) => Promise<{ blob: Blob }>
  requestNotes: (
    blob: Blob,
    metadata: NotesMetadataPayload,
    signal: AbortSignal,
  ) => Promise<NotesResponse>
  /** Crops to the source-space box [ymin, xmin, ymax, xmax] (0..1000) when given. */
  makeThumbnail: (blob: Blob, box: Box2D | null) => Promise<string | null>
  now: () => number
  createUuid: () => string
  loadInitial: () => NotesDocument
  persist: (doc: NotesDocument) => void
}

async function defaultThumbnail(blob: Blob, box: Box2D | null): Promise<string | null> {
  let bitmap: ImageBitmap | undefined
  try {
    bitmap = await createImageBitmap(blob)
    const crop = cropRect(box, bitmap.width, bitmap.height)
    const scale = Math.min(1, 800 / Math.max(crop.w, crop.h))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(crop.w * scale))
    canvas.height = Math.max(1, Math.round(crop.h * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(bitmap, crop.x, crop.y, crop.w, crop.h, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.7)
  } catch {
    return null
  } finally {
    bitmap?.close()
  }
}

const DEFAULT_DEPS: NotesBuilderDeps = {
  sampleFrame: (source, canvas) => sampleGrayscaleFrame(source, canvas, 320),
  captureSnapshot: (source, canvas) => captureJpegBlob(source, canvas, 1600),
  requestNotes: (blob, metadata, signal) => requestNotesUpdate(blob, metadata, signal),
  makeThumbnail: defaultThumbnail,
  now: () => Date.now(),
  createUuid: createRequestId,
  loadInitial: () => {
    purgeLegacyNotes()
    return loadNotes()
  },
  persist: (doc) => saveNotes(doc),
}

const FAILURE_BACKOFF_MS = 10_000

export interface UseNotesBuilderOptions {
  mediaSource: MediaFrameSource | null
  mediaReady: boolean
  sourceGeneration: number
  /** Whether automatic notes are available from the backend. */
  enabled: boolean
  calibrationEditing: boolean
  committedCorners: CalibrationCorners | null
  deps?: Partial<NotesBuilderDeps>
}

interface Captured {
  blob: Blob
  sample: GrayscaleSample
}

interface NotesRequest {
  controller: AbortController
  sample: GrayscaleSample
  startedAt: number
}

/**
 * Builds lecture notes incrementally from calm, content-changing board snapshots. Runs its own
 * low-rate sampling loop and detector state; it shares no state, gate, or request with
 * useBoardMonitor, so notes latency or failures can never delay or alter mistake detection.
 */
export function useNotesBuilder(options: UseNotesBuilderOptions) {
  const {
    mediaSource,
    mediaReady,
    sourceGeneration,
    enabled,
    calibrationEditing,
    committedCorners,
    deps: partialDeps,
  } = options
  const deps: NotesBuilderDeps = useMemo(
    () => ({ ...DEFAULT_DEPS, ...partialDeps }),
    [partialDeps],
  )
  const depsRef = useRef(deps)
  depsRef.current = deps

  const [notes, setNotes] = useState<NotesDocument>(() => deps.loadInitial())
  const notesRef = useRef(notes)
  notesRef.current = notes
  const [phase, setPhase] = useState<NotesPhase>('idle')
  const [error, setError] = useState<string | null>(null)
  const runtime = { mediaSource, mediaReady, sourceGeneration, committedCorners, enabled, calibrationEditing }
  const runtimeRef = useRef(runtime)
  runtimeRef.current = runtime

  const sessionGenRef = useRef(0)
  const detectorRef = useRef<DetectorState>(createDetectorState())
  const calmTicksRef = useRef(0)
  const sentRef = useRef<GrayscaleSample | null>(null)
  const lastSentAtRef = useRef(0)
  const stableRef = useRef<(Captured & { capturedAt: number }) | null>(null)
  const capturingRef = useRef(false)
  const inFlightRef = useRef<NotesRequest | null>(null)
  const pendingRef = useRef<Captured | null>(null)
  const backoffUntilRef = useRef(0)
  const maskRef = useRef<{ key: string; w: number; h: number; mask: Uint8Array | null }>({
    key: '',
    w: 0,
    h: 0,
    mask: null,
  })
  const sampleCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const captureCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const submitRef = useRef<(item: Captured) => void>(() => {})

  const canvas = (ref: React.MutableRefObject<HTMLCanvasElement | null>) => {
    if (!ref.current) ref.current = document.createElement('canvas')
    return ref.current
  }

  const commitNotes = useCallback((next: NotesDocument) => {
    if (notesRef.current === next) return
    notesRef.current = next
    setNotes(next)
    depsRef.current.persist(next)
  }, [])

  const run = useCallback(
    async (item: Captured) => {
      const d = depsRef.current
      const gen = sessionGenRef.current
      const controller = new AbortController()
      const request = { controller, sample: item.sample, startedAt: d.now() }
      inFlightRef.current = request
      setPhase('building')
      const { committedCorners, sourceGeneration } = runtimeRef.current
      const ownsRequest = () => {
        const current = runtimeRef.current
        return !controller.signal.aborted && gen === sessionGenRef.current &&
          current.enabled && !current.calibrationEditing &&
          current.sourceGeneration === sourceGeneration && current.committedCorners === committedCorners
      }
      const metadata: NotesMetadataPayload = {
        request_id: d.createUuid(),
        sections: buildNotesContext(notesRef.current.sections),
        corners: committedCorners,
      }
      try {
        const response = await d.requestNotes(item.blob, metadata, controller.signal)
        if (!ownsRequest()) return
        // One crop per flagged update, taken from the exact frame the model saw.
        const figures = new Map<string, string | null>()
        for (const u of response.updates) {
          if (!u.has_figure) continue
          figures.set(u.id, await d.makeThumbnail(item.blob, u.figure_box_2d))
          if (!ownsRequest()) return
        }
        const now = d.now()
        commitNotes(applyNotesUpdate(notesRef.current, response, figures, now))
        sentRef.current = item.sample
        lastSentAtRef.current = request.startedAt
        if (stableRef.current && stableRef.current.sample === item.sample) {
          stableRef.current = null
        }
        backoffUntilRef.current = 0
        setError(null)
      } catch (err) {
        if (!ownsRequest() || isAbortError(err)) return
        const retryMs =
          err instanceof ApiClientError && err.retryAfterSeconds !== null
            ? err.retryAfterSeconds * 1000
            : FAILURE_BACKOFF_MS
        backoffUntilRef.current = d.now() + retryMs
        pendingRef.current ??= item
        setError(err instanceof Error && err.message ? err.message : 'The notes could not be updated.')
      } finally {
        if (inFlightRef.current === request) {
          inFlightRef.current = null
          const next = pendingRef.current
          const rt = runtimeRef.current
          if (next && ownsRequest() && rt.mediaReady && d.now() >= backoffUntilRef.current) {
            pendingRef.current = null
            submitRef.current(next)
          } else {
            setPhase(rt.enabled && rt.mediaReady && !rt.calibrationEditing ? 'watching' : 'idle')
          }
        }
      }
    },
    [commitNotes],
  )

  const submit = useCallback(
    (item: Captured) => {
      if (inFlightRef.current) {
        pendingRef.current = item
        return
      }
      pendingRef.current = null
      void run(item)
    },
    [run],
  )
  submitRef.current = submit

  const captureCurrent = useCallback(async (sample: GrayscaleSample): Promise<Captured | null> => {
    const rt = runtimeRef.current
    if (!rt.mediaSource || !rt.mediaReady || rt.calibrationEditing || capturingRef.current) return null
    capturingRef.current = true
    const d = depsRef.current
    const gen = sessionGenRef.current
    try {
      const { blob } = await d.captureSnapshot(rt.mediaSource, canvas(captureCanvasRef))
      return gen === sessionGenRef.current ? { blob, sample } : null
    } catch {
      return null
    } finally {
      capturingRef.current = false
    }
  }, [])

  const cancelWork = useCallback(() => {
    sessionGenRef.current += 1
    inFlightRef.current?.controller.abort()
    inFlightRef.current = null
    pendingRef.current = null
  }, [])

  const resetTracking = useCallback(() => {
    cancelWork()
    stableRef.current = null
    sentRef.current = null
    lastSentAtRef.current = 0
    backoffUntilRef.current = 0
    calmTicksRef.current = 0
    detectorRef.current = createDetectorState()
    setError(null)
    const rt = runtimeRef.current
    setPhase(rt.enabled && rt.mediaReady && !rt.calibrationEditing ? 'watching' : 'idle')
  }, [cancelWork])

  const prevGenRef = useRef(sourceGeneration)
  useEffect(() => {
    if (prevGenRef.current !== sourceGeneration) {
      prevGenRef.current = sourceGeneration
      resetTracking()
    }
  }, [resetTracking, sourceGeneration])

  const cornersKey = useMemo(() => JSON.stringify(committedCorners), [committedCorners])
  const prevCornersKeyRef = useRef(cornersKey)
  useEffect(() => {
    if (prevCornersKeyRef.current !== cornersKey) {
      prevCornersKeyRef.current = cornersKey
      resetTracking()
    }
  }, [cornersKey, resetTracking])

  const tick = useCallback(() => {
    const rt = runtimeRef.current
    const d = depsRef.current
    if (!rt.enabled || !rt.mediaSource || !rt.mediaReady || rt.calibrationEditing) return
    const sample = d.sampleFrame(rt.mediaSource, canvas(sampleCanvasRef))
    if (!sample) return

    let mask: Uint8Array | null = null
    if (rt.committedCorners) {
      const cached = maskRef.current
      if (cached.key === cornersKey && cached.w === sample.width && cached.h === sample.height) {
        mask = cached.mask
      } else {
        mask = buildNormalizedQuadMask(rt.committedCorners, sample.width, sample.height)
        maskRef.current = { key: cornersKey, w: sample.width, h: sample.height, mask }
      }
    }

    const det = updateDetector(detectorRef.current, sample, null, mask)
    detectorRef.current = det.state
    calmTicksRef.current =
      det.movingFraction <= NOTES_CALM_MOVING_FRACTION ? calmTicksRef.current + 1 : 0

    const nowMs = d.now()
    const inFlight = inFlightRef.current
    if (pendingRef.current && !inFlight && nowMs >= backoffUntilRef.current) {
      submit(pendingRef.current)
      return
    }
    const sent = inFlight?.sample ?? sentRef.current
    const stable = stableRef.current
    const action = decideNotesAction({
      nowMs,
      calm: calmTicksRef.current >= NOTES_CALM_TICKS,
      hasSent: sent !== null,
      diffFromSent: sent ? changedTileFraction(sent, sample, mask) : 0,
      diffFromStable: stable ? changedTileFraction(stable.sample, sample, mask) : null,
      lastSentAtMs: inFlight?.startedAt ?? lastSentAtRef.current,
      stableCapturedAtMs: stable?.capturedAt ?? null,
    })
    if (action === 'none' || nowMs < backoffUntilRef.current) return

    if (action === 'flush_stable' && stable) {
      stableRef.current = null
      submit({ blob: stable.blob, sample: stable.sample })
      return
    }
    const gen = sessionGenRef.current
    void captureCurrent(sample).then((captured) => {
      const current = runtimeRef.current
      if (!captured || gen !== sessionGenRef.current || !current.enabled || current.calibrationEditing ||
          current.sourceGeneration !== rt.sourceGeneration || current.committedCorners !== rt.committedCorners) return
      if (action === 'capture_stable') {
        stableRef.current = { ...captured, capturedAt: d.now() }
      } else if (action === 'send_now') {
        stableRef.current = null
        submit(captured)
      }
    })
  }, [captureCurrent, cornersKey, submit])

  useEffect(() => {
    if (!enabled || calibrationEditing) {
      cancelWork()
      stableRef.current = null
      calmTicksRef.current = 0
      setPhase('idle')
      return
    }
    if (!mediaReady) {
      calmTicksRef.current = 0
      setPhase(inFlightRef.current ? 'building' : 'idle')
      return
    }
    setPhase((prev) => (prev === 'building' ? prev : 'watching'))
    const timer = window.setInterval(tick, NOTES_SAMPLE_INTERVAL_MS)
    tick()
    return () => window.clearInterval(timer)
  }, [calibrationEditing, cancelWork, enabled, mediaReady, tick])

  useEffect(() => cancelWork, [cancelWork])

  const clear = useCallback(() => {
    resetTracking()
    commitNotes(createEmptyNotes())
  }, [commitNotes, resetTracking])

  return { notes, phase, error, resetTracking, clear }
}
