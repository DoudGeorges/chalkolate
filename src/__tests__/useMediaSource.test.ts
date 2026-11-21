import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { filterAndSortVideoDevices, useMediaSource } from '../hooks/useMediaSource'

function makeFakeStream(label: string, deviceId: string) {
  const stop = vi.fn()
  const track = {
    kind: 'video',
    label,
    readyState: 'live',
    stop,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getSettings: () => ({ deviceId }),
  }
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream
  return { stream, stop }
}

describe('useMediaSource camera lifecycle and reliability', () => {
  const originalMediaDevices = navigator.mediaDevices

  beforeEach(() => {
    vi.restoreAllMocks()
    Object.defineProperty(window, 'isSecureContext', {
      configurable: true,
      value: true,
    })
  })

  afterEach(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: originalMediaDevices,
    })
  })

  it('excludes OBS Virtual Camera and empty placeholders while prioritizing integrated webcam first', () => {
    const filtered = filterAndSortVideoDevices([
      { kind: 'videoinput', deviceId: '', label: '' },
      { kind: 'videoinput', deviceId: 'obs-1', label: 'OBS Virtual Camera' },
      { kind: 'audioinput', deviceId: 'mic-1', label: 'Microphone' },
      { kind: 'videoinput', deviceId: 'usb-1', label: 'Logitech StreamCam' },
      { kind: 'videoinput', deviceId: 'ir-1', label: 'Integrated IR Camera' },
      { kind: 'videoinput', deviceId: 'cam-1', label: 'Integrated Webcam (0c45:672e)' },
      { kind: 'videoinput', deviceId: 'cam-1', label: 'Duplicate Entry' },
    ])

    expect(filtered).toEqual([
      { deviceId: 'cam-1', label: 'Integrated Webcam (0c45:672e)' },
      { deviceId: 'usb-1', label: 'Logitech StreamCam' },
      { deviceId: 'ir-1', label: 'Integrated IR Camera' },
    ])
  })

  it('defaults to integrated webcam, intercepts OS OBS default, stops prior stream before switching, and recovers from NotReadableError', async () => {
    const events: string[] = []
    const obsStream = makeFakeStream('OBS Virtual Camera', 'obs-1')
    const usbCam = makeFakeStream('External USB Webcam', 'usb-1')
    const intCam = makeFakeStream('Integrated Webcam (0c45:672e)', 'int-2')
    obsStream.stop.mockImplementation(() => {
      events.push('stop:obs-1')
    })
    intCam.stop.mockImplementation(() => {
      events.push('stop:int-2')
    })

    let permissionGranted = false
    let usbAttempts = 0
    const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
      const video = constraints.video as MediaTrackConstraints
      const exactId =
        video && typeof video.deviceId === 'object' && 'exact' in video.deviceId
          ? String(video.deviceId.exact)
          : 'default'
      events.push(`getUserMedia:${exactId}`)
      permissionGranted = true
      if (exactId === 'default') {
        return obsStream.stream
      }
      if (exactId === 'usb-1') {
        usbAttempts += 1
        if (usbAttempts === 1) {
          throw new DOMException('Could not start video source', 'NotReadableError')
        }
        return usbCam.stream
      }
      return intCam.stream
    })

    const enumerateDevices = vi.fn(async () =>
      permissionGranted
        ? [
            { kind: 'videoinput', deviceId: 'obs-1', label: 'OBS Virtual Camera' },
            { kind: 'videoinput', deviceId: 'usb-1', label: 'External USB Webcam' },
            { kind: 'videoinput', deviceId: 'int-2', label: 'Integrated Webcam (0c45:672e)' },
          ]
        : [{ kind: 'videoinput', deviceId: '', label: '' }],
    )

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia,
        enumerateDevices,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    })

    const { result, unmount } = renderHook(() =>
      useMediaSource({
        onSourceReset: vi.fn(),
        onGeometryChange: vi.fn(),
        onVideoSeek: vi.fn(),
      }),
    )

    // Mounting never calls getUserMedia automatically and lists no placeholder entries
    expect(getUserMedia).not.toHaveBeenCalled()
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.videoDevices).toEqual([])

    // Default startCamera(): if OS picks OBS initially, it stops OBS and opens Integrated Webcam
    await act(async () => {
      await result.current.startCamera()
    })
    expect(events).toEqual([
      'getUserMedia:default',
      'stop:obs-1',
      'getUserMedia:int-2',
    ])
    expect(result.current.state.kind).toBe('camera')
    expect(result.current.state.label).toBe('Integrated Webcam (0c45:672e)')
    expect(result.current.selectedDeviceId).toBe('int-2')
    expect(result.current.videoDevices).toEqual([
      { deviceId: 'int-2', label: 'Integrated Webcam (0c45:672e)' },
      { deviceId: 'usb-1', label: 'External USB Webcam' },
    ])

    // Re-selecting the already-live active camera does NOT tear down or reopen it
    await act(async () => {
      await result.current.startCamera('int-2')
    })
    expect(events).toHaveLength(3)

    // Switching to external USB camera stops int-2 BEFORE opening usb-1 and recovers from NotReadableError
    await act(async () => {
      await result.current.startCamera('usb-1')
    })
    expect(events).toEqual([
      'getUserMedia:default',
      'stop:obs-1',
      'getUserMedia:int-2',
      'stop:int-2',
      'getUserMedia:usb-1',
      'getUserMedia:usb-1',
    ])
    expect(result.current.state.label).toBe('External USB Webcam')
    expect(result.current.state.error).toBeNull()

    unmount()
    expect(usbCam.stop).toHaveBeenCalled()
  })
})
