import { useCallback, useEffect, useRef, useState } from 'react'
import { renderSampleBoardBlob } from '../lib/sampleBoard'

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

function stopStreamTracks(stream: MediaStream | null): void {
  if (!stream) return
  for (const track of stream.getTracks()) {
    track.stop()
  }
}

function formatCaptureError(err: unknown, mode: 'camera' | 'screen'): string {
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      return mode === 'camera'
        ? 'Camera permission was denied. Allow camera access in browser site settings and retry.'
        : 'Screen share permission was cancelled or denied.'
    }
    if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
      return 'No camera device was found. Connect a camera or use Screen Share / Demo Mode.'
    }
    if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
      return 'Camera is currently in use by another application or could not start.'
    }
    if (err.name === 'OverconstrainedError') {
      return 'Selected camera does not support the requested video constraints.'
    }
  }
  if (err instanceof Error && err.message) {
    return err.message
  }
  return mode === 'camera' ? 'Failed to start camera capture.' : 'Failed to start screen share.'
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
  const videoElRef = useRef<HTMLVideoElement | null>(null)
  const imageElRef = useRef<HTMLImageElement | null>(null)
  const requestSeqRef = useRef<number>(0)
  const callbacksRef = useRef({ onSourceReset, onGeometryChange, onVideoSeek })
  callbacksRef.current = { onSourceReset, onGeometryChange, onVideoSeek }

  const cleanupCurrentMedia = useCallback(() => {
    stopStreamTracks(activeStreamRef.current)
    activeStreamRef.current = null
    if (activeObjectUrlRef.current) {
      URL.revokeObjectURL(activeObjectUrlRef.current)
      activeObjectUrlRef.current = null
    }
    const videoEl = videoElRef.current
    if (videoEl) {
      videoEl.srcObject = null
      videoEl.removeAttribute('src')
      videoEl.load()
    }
  }, [])

  const refreshDevices = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
      return
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      const cams = devices
        .filter((d) => d.kind === 'videoinput')
        .map((d, idx) => ({
          deviceId: d.deviceId,
          label: d.label || `Camera ${idx + 1}`,
        }))
      setVideoDevices(cams)
      setSelectedDeviceId((prev) => {
        if (prev && cams.some((c) => c.deviceId === prev)) return prev
        return cams[0]?.deviceId ?? ''
      })
    } catch {
      // Ignore device enumeration errors prior to permission grant.
    }
  }, [])

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

  const startLiveStream = useCallback(
    async (mode: 'camera' | 'screen', deviceIdOverride?: string) => {
      const seq = ++requestSeqRef.current

      if (typeof window !== 'undefined' && !window.isSecureContext) {
        setState((prev) => ({
          ...prev,
          error:
            'Camera and screen capture require a secure context (HTTPS or localhost).',
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

      let stream: MediaStream
      try {
        if (mode === 'camera') {
          const targetDeviceId = deviceIdOverride ?? selectedDeviceId
          const videoConstraints: MediaTrackConstraints = targetDeviceId
            ? {
                deviceId: { exact: targetDeviceId },
                width: { ideal: 1920 },
                height: { ideal: 1080 },
              }
            : {
                width: { ideal: 1920 },
                height: { ideal: 1080 },
              }
          stream = await navigator.mediaDevices.getUserMedia({
            video: videoConstraints,
            audio: false,
          })
        } else {
          stream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: false,
          })
        }
      } catch (err) {
        if (seq !== requestSeqRef.current) return
        setState((prev) => ({
          ...prev,
          error: formatCaptureError(err, mode),
        }))
        return
      }

      // Discard stale late-arriving stream if another source transition occurred while awaiting.
      if (seq !== requestSeqRef.current) {
        stopStreamTracks(stream)
        return
      }

      cleanupCurrentMedia()
      activeStreamRef.current = stream

      const videoTrack = stream.getVideoTracks()[0]
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
        error: `Unsupported file type "${file.type || file.name}". Upload a browser-decodable image or video.`,
      }))
    },
    [activateBlobSource],
  )

  const loadSampleMistake = useCallback(async () => {
    const seq = ++requestSeqRef.current
    try {
      const blob = await renderSampleBoardBlob()
      if (seq !== requestSeqRef.current) return
      activateBlobSource(blob, 'image', 'Sample Lecture Chalkboard')
    } catch (err) {
      if (seq !== requestSeqRef.current) return
      setState((prev) => ({
        ...prev,
        error:
          err instanceof Error
            ? err.message
            : 'Unable to generate synthetic sample chalkboard.',
      }))
    }
  }, [activateBlobSource])

  // Attach MediaStream / video URL and handle track-ended, decoded readiness, resize, seeked.
  useEffect(() => {
    const stream = state.stream
    if (!stream) return
    const tracks = stream.getVideoTracks()
    const handleEnded = () => {
      clearSource(
        state.kind === 'screen'
          ? 'Screen share ended.'
          : 'Camera feed disconnected.',
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

    const syncVideoReady = () => {
      if (cancelled) return
      if (videoEl.readyState >= 2 && videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
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

    const handleResize = () => {
      syncVideoReady()
    }

    const handleSeeked = () => {
      callbacksRef.current.onVideoSeek()
    }

    const handleError = () => {
      if (cancelled) return
      clearSource('Selected video could not be decoded by this browser.')
    }

    videoEl.addEventListener('loadeddata', syncVideoReady)
    videoEl.addEventListener('canplay', syncVideoReady)
    videoEl.addEventListener('resize', handleResize)
    videoEl.addEventListener('seeked', handleSeeked)
    videoEl.addEventListener('error', handleError)

    if (state.stream) {
      videoEl.srcObject = state.stream
      void videoEl.play().catch(() => {
        // Autoplay should succeed because audio is disabled and video is muted.
      })
    } else if (state.objectUrl) {
      videoEl.srcObject = null
      videoEl.src = state.objectUrl
      videoEl.load()
    }

    syncVideoReady()

    return () => {
      cancelled = true
      videoEl.removeEventListener('loadeddata', syncVideoReady)
      videoEl.removeEventListener('canplay', syncVideoReady)
      videoEl.removeEventListener('resize', handleResize)
      videoEl.removeEventListener('seeked', handleSeeked)
      videoEl.removeEventListener('error', handleError)
    }
  }, [clearSource, state.kind, state.objectUrl, state.stream])

  // Attach image source decode verification
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

  // Cleanup all streams and object URLs on unmount
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
    loadSampleMistake,
    clearSource,
  }
}
