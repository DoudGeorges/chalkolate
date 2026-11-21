import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AudioAutoplayBlockedError,
  playAudioStreamResponse,
  resetAudioPlayerForTests,
  unlockAudioPlayback,
} from '../lib/audioPlayer'

function makeAudioResponse(bytes: Uint8Array): Response {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(copy)
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'audio/mpeg' },
  })
}

describe('audioPlayer', () => {
  const origCreateObjectURL = URL.createObjectURL
  const origRevokeObjectURL = URL.revokeObjectURL

  afterEach(() => {
    resetAudioPlayerForTests()
    URL.createObjectURL = origCreateObjectURL
    URL.revokeObjectURL = origRevokeObjectURL
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('unlockAudioPlayback primes once and reuses the shared audio element for Blob playback', async () => {
    let createdCount = 0
    const createObjectURLSpy = vi.fn(() => {
      createdCount += 1
      return `blob:test-${createdCount}`
    })
    const revokeObjectURLSpy = vi.fn()
    URL.createObjectURL = createObjectURLSpy
    URL.revokeObjectURL = revokeObjectURLSpy

    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})

    const playSpy = vi
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockImplementation(function (this: HTMLMediaElement) {
        if (!this.src.startsWith('data:audio/wav')) {
          queueMicrotask(() => {
            this.dispatchEvent(new Event('playing'))
            queueMicrotask(() => {
              this.dispatchEvent(new Event('ended'))
            })
          })
        }
        return Promise.resolve()
      })

    // Repeated unlock calls while primer src is active only trigger play() once.
    unlockAudioPlayback()
    unlockAudioPlayback()
    expect(playSpy).toHaveBeenCalledTimes(1)

    // Wait for primer .then() cleanup before actual playback.
    await Promise.resolve()
    await Promise.resolve()

    const onStart = vi.fn()
    const controller = new AbortController()
    await playAudioStreamResponse(makeAudioResponse(new Uint8Array([0x49, 0x44, 0x33])), {
      signal: controller.signal,
      onStart,
    })

    expect(playSpy).toHaveBeenCalledTimes(2)
    expect(playSpy.mock.instances[1]).toBe(playSpy.mock.instances[0])
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(createObjectURLSpy).toHaveBeenCalledTimes(1)
    expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:test-1')
  })

  it('falls back seamlessly to buffered Blob playback when addSourceBuffer throws before reading', async () => {
    let urlIdx = 0
    const createObjectURLSpy = vi.fn(() => {
      urlIdx += 1
      return `blob:fallback-${urlIdx}`
    })
    const revokeObjectURLSpy = vi.fn()
    URL.createObjectURL = createObjectURLSpy
    URL.revokeObjectURL = revokeObjectURLSpy

    class FailingAddSourceBufferMediaSource extends EventTarget {
      readyState = 'open'
      static isTypeSupported(mime: string): boolean {
        return mime === 'audio/mpeg'
      }
      addSourceBuffer(): SourceBuffer {
        throw new DOMException('MIME type unsupported in this frame format', 'NotSupportedError')
      }
      endOfStream(): void {}
    }

    vi.stubGlobal('MediaSource', FailingAddSourceBufferMediaSource)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
    const playSpy = vi
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockImplementation(function (this: HTMLMediaElement) {
        queueMicrotask(() => {
          this.dispatchEvent(new Event('playing'))
          queueMicrotask(() => {
            this.dispatchEvent(new Event('ended'))
          })
        })
        return Promise.resolve()
      })

    const onStart = vi.fn()
    await playAudioStreamResponse(makeAudioResponse(new Uint8Array([0xff, 0xfb, 0x90, 0x64])), {
      signal: new AbortController().signal,
      onStart,
    })

    expect(playSpy).toHaveBeenCalledTimes(1)
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(createObjectURLSpy).toHaveBeenCalledTimes(2)
    expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:fallback-1')
    expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:fallback-2')
  })

  it('rejects immediately on NotAllowedError during MSE without retrying Blob playback', async () => {
    const createObjectURLSpy = vi.fn(() => 'blob:mse-blocked')
    const revokeObjectURLSpy = vi.fn()
    URL.createObjectURL = createObjectURLSpy
    URL.revokeObjectURL = revokeObjectURLSpy

    class MockSourceBuffer extends EventTarget {
      updating = false
      appendBuffer(): void {
        queueMicrotask(() => {
          this.dispatchEvent(new Event('updateend'))
        })
      }
    }

    class MockMediaSource extends EventTarget {
      readyState = 'open'
      static isTypeSupported(mime: string): boolean {
        return mime === 'audio/mpeg'
      }
      addSourceBuffer(): SourceBuffer {
        return new MockSourceBuffer() as unknown as SourceBuffer
      }
      endOfStream(): void {}
    }

    vi.stubGlobal('MediaSource', MockMediaSource)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
    const playSpy = vi
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockRejectedValue(new DOMException('Autoplay blocked', 'NotAllowedError'))

    const onStart = vi.fn()
    await expect(
      playAudioStreamResponse(makeAudioResponse(new Uint8Array([0xff, 0xfb, 0x90, 0x64])), {
        signal: new AbortController().signal,
        onStart,
      }),
    ).rejects.toThrow(AudioAutoplayBlockedError)

    expect(playSpy).toHaveBeenCalledTimes(1)
    expect(onStart).not.toHaveBeenCalled()
    expect(createObjectURLSpy).toHaveBeenCalledTimes(1)
    expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:mse-blocked')
  })
})
