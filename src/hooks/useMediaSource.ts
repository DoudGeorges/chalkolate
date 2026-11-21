import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DisplaySurface,
  SELF_CAPTURE_MESSAGE,
  buildDisplayMediaOptions,
  isLikelySelfCapture,
} from '../lib/displayCapture'

export type MediaSourceKind = 'none' | 'camera' | 'screen' | 'image' | 'video'

export interface MediaSourceState {
  kind: MediaSourceKind
  label: string
  stream: MediaStream | null
  objectUrl: string | null
  intrinsicWidth: number
  intrinsicHeight: number
  ready: boolean
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

const EXCLUDED_VIRTUAL_CAMERA_RE = /\bobs\s+virtual\s+camera\b|\bobs[-\s]?virtualcam\b|\bobs-camera\b/i
const INTEGRATED_WEBCAM_RE =
  /integrated|built[\s-]?in|internal|facetime|front\s+camera|truevision|hd\s+user\s+facing|laptop/i
const NON_OBS_VIRTUAL_CAMERA_RE = /virtual|snap\s*camera|manycam|epoccam|iriun|droidcam|ndi/i
const INFRARED_SENSOR_RE = /\bir\b|infrared|depth/i

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
        ? 'Camera permission denied. Allow camera access in browser settings and retry.'
        : 'Screen share cancelled or denied.'
    }
    if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
      return 'No camera found. Connect a camera or upload a video.'
    }
    if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
      return 'Camera is in use by another app or failed to start. Close other apps using it and retry.'
    }
    if (err.name === 'OverconstrainedError') {
      return 'Selected camera does not support the requested video settings.'
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
  return mode === 'camera' ? 'Failed to start camera capture.' : 'Failed to start screen share.'
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
    kind: 'none',
    label: 'No source selected',
    stream: null,
    objectUrl: null,
    intrinsicWidth: 0,
    intrinsicHeight: 0,
    ready: false,
    error: null,
    sourceGeneration: 0,
  })
  const [videoDevices, setVideoDevices] = useState<VideoDeviceOption[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('')

  const activeStreamRef = useRef<MediaStream | null>(null)
  const activeObjectUrlRef = useRef<string | null>(null)
  const activeCameraDeviceIdRef = useRef<string>('')
  const activeKindRef = useRef<MediaSourceKind>('none')
  const videoElRef = useRef<HTMLVideoElement | null>(null)
  const imageElRef = useRef<HTMLImageElement | null>(null)
  const requestSeqRef = useRef<number>(0)
  const hasLoadedFrameRef = useRef<boolean>(false)

  const callbacksRef = useRef({ onSourceReset, onGeometryChange, onVideoSeek })
  callbacksRef.current = { onSourceReset, onGeometryChange, onVideoSeek }

  activeKindRef.current = state.kind

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
        kind: 'none',
        label: 'No source selected',
        stream: null,
        objectUrl: null,
        intrinsicWidth: 0,
        intrinsicHeight: 0,
        ready: false,
        error: errorMessage,
        sourceGeneration: prev.sourceGeneration + 1,
      }))
      callbacksRef.current.onSourceReset()
    },
    [cleanupCurrentMedia],
  )

  const refreshDevices = useCallback(async (): Promise<VideoDeviceOption[]> => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
      return []
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      const cams = filterAndSortVideoDevices(devices)
      setVideoDevices(cams)
      setSelectedDeviceId((prev) => {
        if (prev && cams.some((c) => c.deviceId === prev)) return prev
        if (
          activeCameraDeviceIdRef.current &&
          cams.some((c) => c.deviceId === activeCameraDeviceIdRef.current)
        ) {
          return activeCameraDeviceIdRef.current
        }
        return cams[0]?.deviceId ?? ''
      })

      if (
        activeKindRef.current === 'camera' &&
        activeCameraDeviceIdRef.current &&
        cams.length > 0 &&
        !cams.some((c) => c.deviceId === activeCameraDeviceIdRef.current)
      ) {
        clearSource('Camera disconnected.')
      }
      return cams
    } catch {
      return []
    }
  }, [clearSource])

  useEffect(() => {
    void refreshDevices()
    const mediaDevices = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined
    if (!mediaDevices?.addEventListener) return
    const handleDeviceChange = () => {
      void refreshDevices()
    }
    mediaDevices.addEventListener('devicechange', handleDeviceChange)
    return () => {
      mediaDevices.removeEventListener('devicechange', handleDeviceChange)
    }
  }, [refreshDevices])

  const startLiveStream = useCallback(
    async (mode: 'camera' | 'screen', deviceIdOverride?: string) => {
      let targetDeviceId =
        mode === 'camera' ? (deviceIdOverride ?? (selectedDeviceId || undefined)) : undefined

      if (mode === 'camera' && targetDeviceId === undefined) {
        const currentCams = await refreshDevices()
        targetDeviceId = currentCams[0]?.deviceId
      }

      // Avoid tearing down and reopening an already-live stream for the same camera device.
      if (
        mode === 'camera' &&
        activeKindRef.current === 'camera' &&
        hasLiveVideoTrack(activeStreamRef.current) &&
        (!targetDeviceId || targetDeviceId === activeCameraDeviceIdRef.current)
      ) {
        return
      }

      const seq = ++requestSeqRef.current

      if (typeof window !== 'undefined' && !window.isSecureContext) {
        setState((prev) => ({
          ...prev,
          error: 'Camera and screen capture require a secure context (HTTPS or localhost).',
        }))
        return
      }

      if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
        setState((prev) => ({
          ...prev,
          error: 'Media capture APIs are not supported in this browser.',
        }))
        return
      }

      if (mode === 'camera' && !navigator.mediaDevices.getUserMedia) {
        setState((prev) => ({
          ...prev,
          error: 'Camera capture (getUserMedia) is unavailable in this browser.',
        }))
        return
      }

      if (mode === 'screen' && !navigator.mediaDevices.getDisplayMedia) {
        setState((prev) => ({
          ...prev,
          error: 'Screen Share (getDisplayMedia) is unavailable in this browser.',
        }))
        return
      }

      // Release any currently open media stream BEFORE acquiring a new one so exclusive
      // physical webcam drivers do not fail with NotReadableError.
      cleanupCurrentMedia()

      let stream: MediaStream
      try {
        if (mode === 'camera') {
          stream = await openCameraStreamWithFallbacks(
            targetDeviceId,
            () => seq !== requestSeqRef.current,
          )

          // If Windows/browser defaulted to OBS Virtual Camera before device labels were unlocked,
          // enumerate now-permitted devices, drop OBS, and seamlessly switch to the integrated webcam.
          const firstTrackLabel = stream.getVideoTracks()[0]?.label ?? ''
          if (!deviceIdOverride && isExcludedVirtualCamera(firstTrackLabel)) {
            stopStreamTracks(stream)
            const permittedCams = await refreshDevices()
            const preferredCam = permittedCams[0]
            if (!preferredCam) {
              throw new Error(
                'No supported camera found. Connect an integrated or external webcam or upload a video.',
              )
            }
            targetDeviceId = preferredCam.deviceId
            stream = await openCameraStreamWithFallbacks(
              targetDeviceId,
              () => seq !== requestSeqRef.current,
            )
          }
        } else {
          stream = await navigator.mediaDevices.getDisplayMedia(buildDisplayMediaOptions())
          // Browsers ignoring selfBrowserSurface may still hand back this very tab/window,
          // which would render the app recursively. Refuse it before it reaches the preview.
          const track = stream.getVideoTracks()[0]
          const surface = (track?.getSettings?.() as { displaySurface?: string } | undefined)
            ?.displaySurface as DisplaySurface
          if (track && isLikelySelfCapture(track.label, surface, document.title)) {
            stopStreamTracks(stream)
            throw new Error(SELF_CAPTURE_MESSAGE)
          }
        }
      } catch (err) {
        if (seq !== requestSeqRef.current) return
        setState((prev) => ({
          kind: 'none',
          label: 'No source selected',
          stream: null,
          objectUrl: null,
          intrinsicWidth: 0,
          intrinsicHeight: 0,
          ready: false,
          error: formatCaptureError(err, mode),
          sourceGeneration: prev.sourceGeneration + 1,
        }))
        callbacksRef.current.onSourceReset()
        return
      }

      if (seq !== requestSeqRef.current) {
        stopStreamTracks(stream)
        return
      }

      activeStreamRef.current = stream
      const videoTrack = stream.getVideoTracks()[0]
      const actualDeviceId = videoTrack?.getSettings?.().deviceId ?? ''
      if (mode === 'camera') {
        const resolvedId = actualDeviceId || targetDeviceId || ''
        if (resolvedId) {
          activeCameraDeviceIdRef.current = resolvedId
          setSelectedDeviceId(resolvedId)
        }
      }

      const label =
        videoTrack?.label || (mode === 'camera' ? 'Live Camera' : 'Shared Screen')

      if (mode === 'camera') {
        void refreshDevices()
      }

      setState((prev) => ({
        kind: mode,
        label,
        stream,
        objectUrl: null,
        intrinsicWidth: 0,
        intrinsicHeight: 0,
        ready: false,
        error: null,
        sourceGeneration: prev.sourceGeneration + 1,
      }))
      callbacksRef.current.onSourceReset()
    },
    [cleanupCurrentMedia, refreshDevices, selectedDeviceId],
  )

  const startCamera = useCallback(
    async (deviceId?: string) => {
      if (deviceId !== undefined) {
        setSelectedDeviceId(deviceId)
      }
      await startLiveStream('camera', deviceId)
    },
    [startLiveStream],
  )

  const startScreenShare = useCallback(async () => {
    await startLiveStream('screen')
  }, [startLiveStream])

  const activateBlobSource = useCallback(
    (blob: Blob, kind: 'image' | 'video', label: string) => {
      requestSeqRef.current += 1
      cleanupCurrentMedia()
      const objectUrl = URL.createObjectURL(blob)
      activeObjectUrlRef.current = objectUrl

      setState((prev) => ({
        kind,
        label,
        stream: null,
        objectUrl,
        intrinsicWidth: 0,
        intrinsicHeight: 0,
        ready: false,
        error: null,
        sourceGeneration: prev.sourceGeneration + 1,
      }))
      callbacksRef.current.onSourceReset()
    },
    [cleanupCurrentMedia],
  )

  const loadUploadedFile = useCallback(
    (file: File) => {
      if (file.type.startsWith('image/')) {
        activateBlobSource(file, 'image', file.name || 'Uploaded image')
        return
      }
      if (file.type.startsWith('video/')) {
        activateBlobSource(file, 'video', file.name || 'Uploaded video')
        return
      }
      setState((prev) => ({
        ...prev,
        error: `Unsupported file "${file.type || file.name}". Upload a browser-decodable video or image.`,
      }))
    },
    [activateBlobSource],
  )

  useEffect(() => {
    const stream = state.stream
    if (!stream) return
    const tracks = stream.getVideoTracks()
    const handleEnded = () => {
      clearSource(
        state.kind === 'screen' ? 'Screen share ended.' : 'Camera disconnected.',
      )
    }
    for (const track of tracks) {
      track.addEventListener('ended', handleEnded)
    }
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

    const syncVideoReady = () => {
      if (cancelled) return
      if (videoEl.readyState >= 2 && videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
        hasLoadedFrameRef.current = true
        setState((prev) => {
          const dimsChanged =
            prev.intrinsicWidth !== videoEl.videoWidth ||
            prev.intrinsicHeight !== videoEl.videoHeight
          if (dimsChanged && prev.ready) {
            queueMicrotask(() => callbacksRef.current.onGeometryChange())
          }
          if (
            prev.ready &&
            prev.intrinsicWidth === videoEl.videoWidth &&
            prev.intrinsicHeight === videoEl.videoHeight
          ) {
            return prev
          }
          return {
            ...prev,
            intrinsicWidth: videoEl.videoWidth,
            intrinsicHeight: videoEl.videoHeight,
            ready: true,
            error: null,
          }
        })
      }
    }

    const ensureStreamPlaying = () => {
      if (cancelled || !state.stream) return
      if (videoEl.paused) {
        void videoEl.play().catch(() => {
          // Retry on subsequent loadedmetadata/canplay/unmute events.
        })
      }
      syncVideoReady()
    }

    const handleResize = () => {
      syncVideoReady()
    }

    const handleSeeked = () => {
      // Ignore synthetic seeked events emitted during initial load() before first decoded frame.
      if (!hasLoadedFrameRef.current) return
      callbacksRef.current.onVideoSeek()
    }

    const handleError = () => {
      if (cancelled) return
      clearSource('Selected video could not be decoded by this browser.')
    }

    videoEl.addEventListener('loadedmetadata', ensureStreamPlaying)
    videoEl.addEventListener('loadeddata', syncVideoReady)
    videoEl.addEventListener('canplay', ensureStreamPlaying)
    videoEl.addEventListener('playing', syncVideoReady)
    videoEl.addEventListener('resize', handleResize)
    videoEl.addEventListener('seeked', handleSeeked)
    videoEl.addEventListener('error', handleError)

    const videoTracks = state.stream ? state.stream.getVideoTracks() : []
    for (const track of videoTracks) {
      track.addEventListener('unmute', ensureStreamPlaying)
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
      ensureStreamPlaying()
    } else if (state.objectUrl) {
      hasLoadedFrameRef.current = false
      videoEl.srcObject = null
      videoEl.src = state.objectUrl
      videoEl.load()
    }

    syncVideoReady()

    return () => {
      cancelled = true
      if (
        frameCallbackHandle !== null &&
        typeof videoEl.cancelVideoFrameCallback === 'function'
      ) {
        videoEl.cancelVideoFrameCallback(frameCallbackHandle)
      }
      for (const track of videoTracks) {
        track.removeEventListener('unmute', ensureStreamPlaying)
      }
      videoEl.removeEventListener('loadedmetadata', ensureStreamPlaying)
      videoEl.removeEventListener('loadeddata', syncVideoReady)
      videoEl.removeEventListener('canplay', ensureStreamPlaying)
      videoEl.removeEventListener('playing', syncVideoReady)
      videoEl.removeEventListener('resize', handleResize)
      videoEl.removeEventListener('seeked', handleSeeked)
      videoEl.removeEventListener('error', handleError)
    }
  }, [clearSource, state.kind, state.objectUrl, state.stream])

  useEffect(() => {
    const imgEl = imageElRef.current
    if (!imgEl || state.kind !== 'image' || !state.objectUrl) return

    let cancelled = false

    const handleLoad = () => {
      if (cancelled) return
      if (imgEl.naturalWidth <= 0 || imgEl.naturalHeight <= 0) {
        clearSource('Uploaded image has zero dimensions.')
        return
      }
      setState((prev) => ({
        ...prev,
        intrinsicWidth: imgEl.naturalWidth,
        intrinsicHeight: imgEl.naturalHeight,
        ready: true,
        error: null,
      }))
    }

    const handleError = () => {
      if (cancelled) return
      clearSource('Uploaded image could not be decoded by this browser.')
    }

    imgEl.addEventListener('load', handleLoad)
    imgEl.addEventListener('error', handleError)
    if (imgEl.complete && imgEl.naturalWidth > 0) {
      handleLoad()
    }

    return () => {
      cancelled = true
      imgEl.removeEventListener('load', handleLoad)
      imgEl.removeEventListener('error', handleError)
    }
  }, [clearSource, state.kind, state.objectUrl])

  useEffect(() => {
    return () => {
      requestSeqRef.current += 1
      cleanupCurrentMedia()
    }
  }, [cleanupCurrentMedia])

  return {
    state,
    videoDevices,
    selectedDeviceId,
    setSelectedDeviceId,
    videoElRef,
    imageElRef,
    startCamera,
    startScreenShare,
    loadUploadedFile,
    clearSource,
  }
}
