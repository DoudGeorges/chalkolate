import { useCallback, useEffect, useRef, useState } from 'react'
import { isAbortError } from '../lib/abort'
import {
  DisplaySurface,
  SELF_CAPTURE_MESSAGE,
  buildDisplayMediaOptions,
  isLikelySelfCapture,
} from '../lib/displayCapture'

export type MediaSourceKind = 'none' | 'camera' | 'screen' | 'video'

export interface MediaSourceState {
  kind: MediaSourceKind
  stream: MediaStream | null
  objectUrl: string | null
  intrinsicWidth: number
  intrinsicHeight: number
  ready: boolean
  videoPlaying: boolean
  previewNeedsGesture: boolean
  error: string | null
  sourceGeneration: number
}

export interface VideoDeviceOption {
  deviceId: string
  label: string
}

export interface UseMediaSourceOptions {
  onSourceReset: () => void
  onGeometryChange: () => void
  onVideoSeek: () => void
}

const EMPTY_SOURCE = {
  kind: 'none',
  stream: null,
  objectUrl: null,
  intrinsicWidth: 0,
  intrinsicHeight: 0,
  ready: false,
  videoPlaying: false,
  previewNeedsGesture: false,
  error: null,
} satisfies Omit<MediaSourceState, 'sourceGeneration'>

const EXCLUDED_VIRTUAL_CAMERA_RE = /\bobs\s+virtual\s+camera\b|\bobs[-\s]?virtualcam\b|\bobs-camera\b/i
const INTEGRATED_WEBCAM_RE =
  /integrated|built[\s-]?in|internal|facetime|front\s+camera|truevision|hd\s+user\s+facing|laptop/i
const NON_OBS_VIRTUAL_CAMERA_RE = /virtual|snap\s*camera|manycam|epoccam|iriun|droidcam|ndi/i
const INFRARED_SENSOR_RE = /\bir\b|infrared|depth/i
const VIDEO_FILE_EXTENSION_RE = /\.(mp4|m4v|mov|webm|ogv)$/i

export function isExcludedVirtualCamera(label: string): boolean {
  return EXCLUDED_VIRTUAL_CAMERA_RE.test(label)
}

export function cameraDevicePriority(label: string): number {
  if (INFRARED_SENSOR_RE.test(label)) return 3
  if (INTEGRATED_WEBCAM_RE.test(label) && !NON_OBS_VIRTUAL_CAMERA_RE.test(label)) return 0
  if (NON_OBS_VIRTUAL_CAMERA_RE.test(label)) return 2
  return 1
}

export function filterAndSortVideoDevices(
  devices: ReadonlyArray<Pick<MediaDeviceInfo, 'kind' | 'deviceId' | 'label'>>,
): VideoDeviceOption[] {
  const seen = new Set<string>()
  const collected: Array<{ option: VideoDeviceOption; priority: number; index: number }> = []

  for (const d of devices) {
    if (d.kind !== 'videoinput') continue
    const id = d.deviceId.trim()
    // Exclude pre-permission browser placeholder entries lacking a real deviceId.
    if (!id || seen.has(id)) continue
    seen.add(id)

    const rawLabel = d.label.trim()
    if (isExcludedVirtualCamera(rawLabel)) continue

    const label = rawLabel || `Camera ${collected.length + 1}`
    collected.push({
      option: { deviceId: id, label },
      priority: cameraDevicePriority(rawLabel),
      index: collected.length,
    })
  }

  collected.sort((a, b) => a.priority - b.priority || a.index - b.index)
  return collected.map((entry) => entry.option)
}

function stopStreamTracks(stream: MediaStream | null): void {
  if (!stream) return
  for (const track of stream.getTracks()) {
    track.stop()
  }
}

function hasLiveVideoTrack(stream: MediaStream | null): boolean {
  if (!stream) return false
  return stream.getVideoTracks().some((track) => track.readyState === 'live')
}

function formatCaptureError(err: unknown, mode: 'camera' | 'screen'): string {
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      return mode === 'camera'
        ? 'Allow camera access in your browser settings, then try again.'
        : 'Screen sharing did not start. Select Share screen to try again.'
    }
    if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
      return mode === 'camera'
        ? 'No camera was found. Connect a camera or share your screen.'
        : 'No screen was available to share.'
    }
    if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
      return mode === 'camera'
        ? 'The camera could not start. Close any other app using it and try again.'
        : 'The screen share could not start. Select Share screen to try again.'
    }
    if (err.name === 'OverconstrainedError') {
      return 'This camera does not support the requested video settings.'
    }
    if (err.name === 'NotSupportedError') {
      return mode === 'screen'
        ? 'Screen sharing is not supported in this browser.'
        : 'Camera capture is not supported in this browser.'
    }
  }
  if (err instanceof Error && err.message) {
    return err.message
  }
  return mode === 'camera' ? 'The camera could not start. Try again.' : 'Screen sharing could not start. Try again.'
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

async function openCameraStreamWithFallbacks(
  deviceId: string | undefined,
  isStale: () => boolean,
): Promise<MediaStream> {
  const exactDevice: MediaTrackConstraints = deviceId ? { deviceId: { exact: deviceId } } : {}
  const preferredConstraints: MediaTrackConstraints = {
    ...exactDevice,
    width: { ideal: 1920 },
    height: { ideal: 1080 },
  }

  try {
    return await navigator.mediaDevices.getUserMedia({
      video: preferredConstraints,
      audio: false,
    })
  } catch (err) {
    if (isStale()) throw err

    if (
      err instanceof DOMException &&
      (err.name === 'NotReadableError' || err.name === 'AbortError')
    ) {
      // Give exclusive camera drivers time to release the prior handle before retrying.
      await delayMs(350)
      if (isStale()) throw err
      try {
        return await navigator.mediaDevices.getUserMedia({
          video: deviceId ? exactDevice : true,
          audio: false,
        })
      } catch (retryErr) {
        if (isStale() || !deviceId) throw retryErr
        if (retryErr instanceof DOMException && retryErr.name === 'OverconstrainedError') {
          return navigator.mediaDevices.getUserMedia({
            video: { deviceId: { ideal: deviceId } },
            audio: false,
          })
        }
        throw retryErr
      }
    }

    if (err instanceof DOMException && err.name === 'OverconstrainedError') {
      try {
        return await navigator.mediaDevices.getUserMedia({
          video: deviceId ? exactDevice : true,
          audio: false,
        })
      } catch (fallbackErr) {
        if (isStale() || !deviceId) throw fallbackErr
        if (
          fallbackErr instanceof DOMException &&
          (fallbackErr.name === 'OverconstrainedError' || fallbackErr.name === 'NotFoundError')
        ) {
          return navigator.mediaDevices.getUserMedia({
            video: { deviceId: { ideal: deviceId } },
            audio: false,
          })
        }
        throw fallbackErr
      }
    }

    if (
      deviceId &&
      err instanceof DOMException &&
      (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError')
    ) {
      // Previously selected device may have disconnected; fall back to default available camera.
      return navigator.mediaDevices.getUserMedia({
        video: true,
        audio: false,
      })
    }

    throw err
  }
}

export function useMediaSource(options: UseMediaSourceOptions) {
  const { onSourceReset, onGeometryChange, onVideoSeek } = options

  const [state, setState] = useState<MediaSourceState>({
    ...EMPTY_SOURCE,
    sourceGeneration: 0,
  })

  const activeStreamRef = useRef<MediaStream | null>(null)
  const activeObjectUrlRef = useRef<string | null>(null)
  const activeCameraDeviceIdRef = useRef<string>('')
  const videoElRef = useRef<HTMLVideoElement | null>(null)
  const requestSeqRef = useRef<number>(0)
  const hasLoadedFrameRef = useRef<boolean>(false)

  const callbacksRef = useRef({ onSourceReset, onGeometryChange, onVideoSeek })
  callbacksRef.current = { onSourceReset, onGeometryChange, onVideoSeek }

  const cleanupCurrentMedia = useCallback(() => {
    hasLoadedFrameRef.current = false
    stopStreamTracks(activeStreamRef.current)
    activeStreamRef.current = null
    activeCameraDeviceIdRef.current = ''
    if (activeObjectUrlRef.current) {
      URL.revokeObjectURL(activeObjectUrlRef.current)
      activeObjectUrlRef.current = null
    }
    const videoEl = videoElRef.current
    if (videoEl) {
      const hadSrcAttr = videoEl.hasAttribute('src')
      videoEl.pause()
      videoEl.srcObject = null
      // Only invoke load() when clearing a file src URL; calling load() during srcObject
      // swaps triggers asynchronous pipeline resets that can freeze live cameras.
      if (hadSrcAttr) {
        videoEl.removeAttribute('src')
        videoEl.load()
      }
    }
  }, [])

  const clearSource = useCallback(
    (errorMessage: string | null = null) => {
      requestSeqRef.current += 1
      cleanupCurrentMedia()
      setState((prev) => ({
        ...EMPTY_SOURCE,
        error: errorMessage,
        sourceGeneration: prev.sourceGeneration + 1,
      }))
      callbacksRef.current.onSourceReset()
    },
    [cleanupCurrentMedia],
  )

  const listCameras = useCallback(async (): Promise<VideoDeviceOption[]> => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
      return []
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      return filterAndSortVideoDevices(devices)
    } catch {
      return []
    }
  }, [])

  useEffect(() => {
    if (state.kind !== 'camera' || !state.stream) return
    const mediaDevices = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined
    if (!mediaDevices?.addEventListener) return
    const stream = state.stream
    const handleDeviceChange = async () => {
      const cameras = await listCameras()
      const id = activeCameraDeviceIdRef.current
      if (activeStreamRef.current === stream && id && cameras.length > 0 &&
          !cameras.some((camera) => camera.deviceId === id)) {
        clearSource('Camera disconnected.')
      }
    }
    mediaDevices.addEventListener('devicechange', handleDeviceChange)
    return () => {
      mediaDevices.removeEventListener('devicechange', handleDeviceChange)
    }
  }, [clearSource, listCameras, state.kind, state.stream])

  const startLiveStream = useCallback(
    async (mode: 'camera' | 'screen') => {
      const seq = ++requestSeqRef.current
      // Avoid reopening an already-live camera.
      if (mode === 'camera' && state.kind === 'camera' && hasLiveVideoTrack(activeStreamRef.current)) {
        return
      }

      if (typeof window !== 'undefined' && !window.isSecureContext) {
        setState((prev) => ({
          ...prev,
          error: 'To use a camera or share a screen, open Chalkolate over HTTPS or on localhost.',
        }))
        return
      }

      if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
        setState((prev) => ({
          ...prev,
          error: 'This browser cannot open a camera or share a screen. Choose a video file instead.',
        }))
        return
      }

      if (mode === 'camera' && !navigator.mediaDevices.getUserMedia) {
        setState((prev) => ({
          ...prev,
          error: 'Camera access is unavailable in this browser.',
        }))
        return
      }

      if (mode === 'screen' && !navigator.mediaDevices.getDisplayMedia) {
        setState((prev) => ({
          ...prev,
          error: 'Screen sharing is unavailable in this browser.',
        }))
        return
      }

      // Release any currently open media stream BEFORE acquiring a new one so exclusive
      // physical webcam drivers do not fail with NotReadableError.
      cleanupCurrentMedia()

      let stream: MediaStream | null = null
      let targetDeviceId: string | undefined
      try {
        if (mode === 'camera') {
          const cameras = await listCameras()
          if (seq !== requestSeqRef.current) return
          targetDeviceId = cameras[0]?.deviceId
          stream = await openCameraStreamWithFallbacks(
            targetDeviceId,
            () => seq !== requestSeqRef.current,
          )
          if (seq !== requestSeqRef.current) {
            stopStreamTracks(stream)
            return
          }

          if (!targetDeviceId || isExcludedVirtualCamera(stream.getVideoTracks()[0]?.label ?? '')) {
            // Camera labels become available after permission, so reconsider the default device.
            const permittedCams = await listCameras()
            if (seq !== requestSeqRef.current) {
              stopStreamTracks(stream)
              return
            }
            const firstTrack = stream.getVideoTracks()[0]
            const firstDeviceId = firstTrack?.getSettings().deviceId
            const preferred = permittedCams[0]
            const excluded = isExcludedVirtualCamera(firstTrack?.label ?? '')
            if (preferred && (excluded || (firstDeviceId && firstDeviceId !== preferred.deviceId))) {
              stopStreamTracks(stream)
              targetDeviceId = preferred.deviceId
              stream = await openCameraStreamWithFallbacks(
                targetDeviceId,
                () => seq !== requestSeqRef.current,
              )
            }
          }
          if (isExcludedVirtualCamera(stream.getVideoTracks()[0]?.label ?? '')) {
            throw new Error('Connect an integrated or external camera, or share your screen.')
          }
        } else {
          stream = await navigator.mediaDevices.getDisplayMedia(buildDisplayMediaOptions())
          // Browsers ignoring selfBrowserSurface may still hand back this very tab/window,
          // which would render the app recursively. Refuse it before it reaches the preview.
          const track = stream.getVideoTracks()[0]
          const surface = (track?.getSettings?.() as { displaySurface?: string } | undefined)
            ?.displaySurface as DisplaySurface
          if (track && isLikelySelfCapture(track.label, surface, document.title)) {
            throw new Error(SELF_CAPTURE_MESSAGE)
          }
        }
        if (!hasLiveVideoTrack(stream)) throw new Error('The source closed before it could open. Try again.')
      } catch (err) {
        stopStreamTracks(stream)
        if (seq !== requestSeqRef.current) return
        clearSource(formatCaptureError(err, mode))
        return
      }

      if (seq !== requestSeqRef.current) {
        stopStreamTracks(stream)
        return
      }

      activeStreamRef.current = stream
      if (mode === 'camera') {
        activeCameraDeviceIdRef.current = stream.getVideoTracks()[0]?.getSettings().deviceId ?? ''
      }

      setState((prev) => ({
        ...EMPTY_SOURCE,
        kind: mode,
        stream,
        sourceGeneration: prev.sourceGeneration + 1,
      }))
      callbacksRef.current.onSourceReset()
    },
    [cleanupCurrentMedia, clearSource, listCameras, state.kind],
  )

  const startCamera = useCallback(
    () => startLiveStream('camera'),
    [startLiveStream],
  )

  const startScreenShare = useCallback(async () => {
    await startLiveStream('screen')
  }, [startLiveStream])

  const loadUploadedFile = useCallback(
    (file: File) => {
      const untyped = !file.type || file.type === 'application/octet-stream'
      const supportedType = file.type.startsWith('video/') || (untyped && VIDEO_FILE_EXTENSION_RE.test(file.name))
      if (!file.size || !supportedType) {
        clearSource('Choose a video file your browser can play.')
        return
      }
      requestSeqRef.current += 1
      cleanupCurrentMedia()
      const objectUrl = URL.createObjectURL(file)
      activeObjectUrlRef.current = objectUrl

      setState((prev) => ({
        ...EMPTY_SOURCE,
        kind: 'video',
        objectUrl,
        sourceGeneration: prev.sourceGeneration + 1,
      }))
      callbacksRef.current.onSourceReset()
    },
    [cleanupCurrentMedia, clearSource],
  )

  useEffect(() => {
    const stream = state.stream
    if (!stream) return
    const tracks = stream.getVideoTracks()
    const handleEnded = () => {
      if (activeStreamRef.current !== stream || hasLiveVideoTrack(stream)) return
      clearSource(
        state.kind === 'screen' ? 'Screen share ended.' : 'Camera disconnected.',
      )
    }
    for (const track of tracks) {
      track.addEventListener('ended', handleEnded)
    }
    handleEnded()
    return () => {
      for (const track of tracks) {
        track.removeEventListener('ended', handleEnded)
      }
    }
  }, [clearSource, state.kind, state.stream])

  useEffect(() => {
    const videoEl = videoElRef.current
    if (!videoEl) return

    if (state.kind !== 'camera' && state.kind !== 'screen' && state.kind !== 'video') {
      return
    }

    let cancelled = false
    let frameCallbackHandle: number | null = null
    let lastWidth = 0
    let lastHeight = 0
    const hasCurrentSource = () => state.stream
      ? activeStreamRef.current === state.stream && videoEl.srcObject === state.stream
      : activeObjectUrlRef.current === state.objectUrl && videoEl.src === state.objectUrl

    const syncVideoReady = () => {
      if (cancelled || !hasCurrentSource()) return
      // A stream can decode its first frame before the preview is playing.
      if (state.stream && videoEl.paused && !hasLoadedFrameRef.current) return
      const { videoWidth: width, videoHeight: height, readyState } = videoEl
      if (readyState < 2 || width <= 0 || height <= 0 || (lastWidth === width && lastHeight === height)) return

      const dimensionsChanged = lastWidth > 0
      hasLoadedFrameRef.current = true
      lastWidth = width
      lastHeight = height
      setState((prev) => prev.sourceGeneration === state.sourceGeneration ? {
        ...prev,
        intrinsicWidth: width,
        intrinsicHeight: height,
        ready: true,
        error: null,
      } : prev)
      if (dimensionsChanged) callbacksRef.current.onGeometryChange()
    }

    const syncVideoPlayback = () => {
      if (cancelled || !hasCurrentSource()) return
      const videoPlaying = !videoEl.paused && !videoEl.ended && !videoEl.seeking
      setState((prev) => {
        if (prev.sourceGeneration !== state.sourceGeneration) return prev
        const previewNeedsGesture = prev.previewNeedsGesture && !videoPlaying
        if (prev.videoPlaying === videoPlaying && prev.previewNeedsGesture === previewNeedsGesture) {
          return prev
        }
        return { ...prev, videoPlaying, previewNeedsGesture }
      })
    }

    const handlePlaying = () => {
      syncVideoReady()
      syncVideoPlayback()
    }

    const handleSeeking = () => {
      syncVideoPlayback()
      if (state.kind === 'video' && hasCurrentSource() && hasLoadedFrameRef.current) {
        callbacksRef.current.onVideoSeek()
      }
    }

    const handleError = () => {
      if (cancelled || !hasCurrentSource()) return
      clearSource(state.kind === 'video'
        ? 'This browser could not play the video. Choose a different file.'
        : 'The preview could not be played. Open the source again.')
    }

    videoEl.addEventListener('loadeddata', syncVideoReady)
    videoEl.addEventListener('canplay', syncVideoReady)
    videoEl.addEventListener('playing', handlePlaying)
    videoEl.addEventListener('resize', syncVideoReady)
    videoEl.addEventListener('seeking', handleSeeking)
    videoEl.addEventListener('seeked', syncVideoPlayback)
    videoEl.addEventListener('pause', syncVideoPlayback)
    videoEl.addEventListener('ended', syncVideoPlayback)
    videoEl.addEventListener('error', handleError)

    const videoTracks = state.stream ? state.stream.getVideoTracks() : []
    for (const track of videoTracks) {
      track.addEventListener('unmute', syncVideoReady)
    }

    if (state.stream) {
      if (videoEl.hasAttribute('src')) {
        videoEl.removeAttribute('src')
      }
      videoEl.muted = true
      videoEl.playsInline = true
      if (videoEl.srcObject !== state.stream) {
        videoEl.srcObject = state.stream
      }
      if (typeof videoEl.requestVideoFrameCallback === 'function') {
        const onFrame = () => {
          frameCallbackHandle = null
          if (cancelled) return
          syncVideoReady()
          if (
            (!hasLoadedFrameRef.current || videoEl.videoWidth === 0) &&
            typeof videoEl.requestVideoFrameCallback === 'function'
          ) {
            frameCallbackHandle = videoEl.requestVideoFrameCallback(onFrame)
          }
        }
        frameCallbackHandle = videoEl.requestVideoFrameCallback(onFrame)
      }
    } else if (state.objectUrl) {
      hasLoadedFrameRef.current = false
      videoEl.srcObject = null
      videoEl.src = state.objectUrl
      videoEl.load()
    }

    syncVideoReady()
    // Opening a source starts only the muted preview. The toolbar owns mistake monitoring.
    void videoEl.play().catch((err: unknown) => {
      if (cancelled || !hasCurrentSource() || !videoEl.paused || isAbortError(err)) return
      setState((prev) => prev.sourceGeneration === state.sourceGeneration
        ? { ...prev, previewNeedsGesture: true }
        : prev)
    })

    return () => {
      cancelled = true
      if (
        frameCallbackHandle !== null &&
        typeof videoEl.cancelVideoFrameCallback === 'function'
      ) {
        videoEl.cancelVideoFrameCallback(frameCallbackHandle)
      }
      for (const track of videoTracks) {
        track.removeEventListener('unmute', syncVideoReady)
      }
      videoEl.removeEventListener('loadeddata', syncVideoReady)
      videoEl.removeEventListener('canplay', syncVideoReady)
      videoEl.removeEventListener('playing', handlePlaying)
      videoEl.removeEventListener('resize', syncVideoReady)
      videoEl.removeEventListener('seeking', handleSeeking)
      videoEl.removeEventListener('seeked', syncVideoPlayback)
      videoEl.removeEventListener('pause', syncVideoPlayback)
      videoEl.removeEventListener('ended', syncVideoPlayback)
      videoEl.removeEventListener('error', handleError)
    }
  }, [clearSource, state.kind, state.objectUrl, state.sourceGeneration, state.stream])

  useEffect(() => {
    return () => {
      requestSeqRef.current += 1
      cleanupCurrentMedia()
    }
  }, [cleanupCurrentMedia])

  return {
    state,
    videoElRef,
    startCamera,
    startScreenShare,
    loadUploadedFile,
    clearSource,
  }
}
