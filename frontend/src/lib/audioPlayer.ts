export interface PlayAudioStreamOptions {
  signal: AbortSignal
  onStart: () => void
}

export class AudioAutoplayBlockedError extends Error {
  constructor() {
    super('Audio playback blocked by browser autoplay policy.')
    this.name = 'AudioAutoplayBlockedError'
  }
}

const SILENT_WAV_DATA_URI =
  'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA'

let sharedAudioElement: HTMLAudioElement | null = null
let isPlayingSharedAudio = false

function getSharedAudioElement(): HTMLAudioElement | null {
  if (sharedAudioElement) return sharedAudioElement
  if (typeof document === 'undefined') return null
  sharedAudioElement = document.createElement('audio')
  sharedAudioElement.preload = 'auto'
  return sharedAudioElement
}

export function resetAudioPlayerForTests(): void {
  if (sharedAudioElement) {
    try {
      sharedAudioElement.pause()
      sharedAudioElement.removeAttribute('src')
    } catch {
      // Ignore cleanup errors on detached media elements.
    }
  }
  sharedAudioElement = null
  isPlayingSharedAudio = false
}

/**
 * Primes the shared audio element synchronously inside a user gesture (Start / Speak)
 * so follow-up async ElevenLabs responses satisfy per-element autoplay rules without
 * interrupting active speech playback.
 */
export function unlockAudioPlayback(): void {
  const el = getSharedAudioElement()
  if (!el || isPlayingSharedAudio || !el.paused || Boolean(el.getAttribute('src'))) {
    return
  }
  try {
    el.muted = false
    el.volume = 1
    el.src = SILENT_WAV_DATA_URI
    if (typeof el.play === 'function') {
      const promise = el.play()
      if (promise && typeof promise.then === 'function') {
        void promise
          .then(() => {
            if (!isPlayingSharedAudio) {
              el.pause()
              el.removeAttribute('src')
            }
          })
          .catch(() => {
            if (!isPlayingSharedAudio) {
              el.pause()
              el.removeAttribute('src')
            }
          })
      }
    }
  } catch {
    // Best-effort unlock only; ignore environments without audio decode support.
  }
}

function createAbortError(): DOMException {
  return new DOMException('Speech playback aborted.', 'AbortError')
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

function waitForEvent(
  target: EventTarget,
  eventName: string,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(createAbortError())
      return
    }
    const onEvent = () => {
      cleanup()
      resolve()
    }
    const onAbort = () => {
      cleanup()
      reject(createAbortError())
    }
    const cleanup = () => {
      target.removeEventListener(eventName, onEvent)
      signal.removeEventListener('abort', onAbort)
    }
    target.addEventListener(eventName, onEvent, { once: true })
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function waitForAudioCompletion(
  audio: HTMLAudioElement,
  signal: AbortSignal,
  notifyStarted: () => void,
): Promise<void> {
  if (signal.aborted) {
    throw createAbortError()
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false

    const cleanup = () => {
      audio.removeEventListener('playing', handlePlaying)
      audio.removeEventListener('ended', handleEnded)
      audio.removeEventListener('error', handleError)
      signal.removeEventListener('abort', handleAbort)
    }

    const handlePlaying = () => {
      if (!settled && !signal.aborted) {
        notifyStarted()
      }
    }

    const handleEnded = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }

    const handleError = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('Audio element playback failed.'))
    }

    const handleAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(createAbortError())
    }

    audio.addEventListener('playing', handlePlaying)
    audio.addEventListener('ended', handleEnded, { once: true })
    audio.addEventListener('error', handleError, { once: true })
    signal.addEventListener('abort', handleAbort, { once: true })

    audio
      .play()
      .then(() => {
        if (!settled && !signal.aborted && !audio.paused) {
          notifyStarted()
        }
      })
      .catch((err: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        if (signal.aborted) {
          reject(createAbortError())
          return
        }
        if (err instanceof DOMException && err.name === 'NotAllowedError') {
          reject(new AudioAutoplayBlockedError())
          return
        }
        reject(err instanceof Error ? err : new Error('Audio playback failed.'))
      })
  })
}

function cleanupAudioElement(audio: HTMLAudioElement | null, objectUrl: string | null): void {
  if (audio) {
    try {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
    } catch {
      // Ignore cleanup errors on detached media elements.
    }
  }
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl)
  }
}

async function playBlobObject(
  blob: Blob,
  signal: AbortSignal,
  notifyStarted: () => void,
): Promise<void> {
  if (signal.aborted) {
    throw createAbortError()
  }
  if (blob.size === 0) {
    throw new Error('Received empty speech audio stream.')
  }

  const audio = getSharedAudioElement()
  if (!audio) {
    throw new Error('Audio element playback is unavailable in this environment.')
  }

  isPlayingSharedAudio = true
  cleanupAudioElement(audio, null)
  const objectUrl = URL.createObjectURL(blob)
  audio.src = objectUrl

  const onAbortPlayback = () => {
    try {
      audio.pause()
    } catch {
      // Ignore pause errors during abort.
    }
  }
  signal.addEventListener('abort', onAbortPlayback, { once: true })

  try {
    await waitForAudioCompletion(audio, signal, notifyStarted)
  } finally {
    signal.removeEventListener('abort', onAbortPlayback)
    isPlayingSharedAudio = false
    cleanupAudioElement(audio, objectUrl)
  }
}

async function playWithMediaSourceOrFallbackBlob(
  response: Response,
  signal: AbortSignal,
  onStart: () => void,
): Promise<void> {
  const body = response.body
  if (!body) {
    throw new Error('Speech response stream body is missing.')
  }

  const audio = getSharedAudioElement()
  if (!audio) {
    throw new Error('Audio element playback is unavailable in this environment.')
  }

  isPlayingSharedAudio = true
  cleanupAudioElement(audio, null)
  const mediaSource = new MediaSource()
  const objectUrl = URL.createObjectURL(mediaSource)
  audio.src = objectUrl

  const collectedChunks: BlobPart[] = []
  let didStart = false
  const notifyStartedOnce = () => {
    if (!didStart && !signal.aborted) {
      didStart = true
      onStart()
    }
  }

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  const handleAbort = () => {
    try {
      audio.pause()
    } catch {
      // Ignore pause errors during abort.
    }
    if (reader) {
      void reader.cancel().catch(() => {})
    }
  }
  signal.addEventListener('abort', handleAbort, { once: true })

  let fallbackToBufferedResponse = false
  let fallbackBlob: Blob | null = null

  try {
    if (mediaSource.readyState !== 'open') {
      await waitForEvent(mediaSource, 'sourceopen', signal)
    }

    const sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg')
    reader = body.getReader()
    let playStarted = false
    let completionPromise: Promise<void> | null = null
    let playError: Error | null = null

    while (true) {
      if (playError) throw playError
      if (signal.aborted) {
        throw createAbortError()
      }
      const { value, done } = await reader.read()
      if (done) break
      if (!value || value.byteLength === 0) continue

      const chunkCopy = new Uint8Array(value.byteLength)
      chunkCopy.set(value)
      collectedChunks.push(chunkCopy)

      if (sourceBuffer.updating) {
        await waitForEvent(sourceBuffer, 'updateend', signal)
      }
      if (signal.aborted) {
        throw createAbortError()
      }

      sourceBuffer.appendBuffer(chunkCopy)
      await waitForEvent(sourceBuffer, 'updateend', signal)

      if (!playStarted) {
        playStarted = true
        completionPromise = waitForAudioCompletion(audio, signal, notifyStartedOnce)
        completionPromise.catch((err: unknown) => {
          playError = err instanceof Error ? err : new Error('Audio playback failed.')
        })
      }
    }

    if (playError) throw playError
    if (signal.aborted) {
      throw createAbortError()
    }

    if (sourceBuffer.updating) {
      await waitForEvent(sourceBuffer, 'updateend', signal)
    }
    if (mediaSource.readyState === 'open') {
      mediaSource.endOfStream()
    }

    if (completionPromise) {
      await completionPromise
    } else if (audio.buffered.length > 0) {
      await waitForAudioCompletion(audio, signal, notifyStartedOnce)
    } else {
      throw new Error('Received empty audio stream.')
    }
  } catch (err) {
    if (signal.aborted || isAbortError(err)) {
      throw createAbortError()
    }
    if (err instanceof AudioAutoplayBlockedError || didStart) {
      throw err
    }

    if (!reader) {
      // Failed before acquiring the stream reader (e.g. sourceopen or addSourceBuffer):
      // fall back cleanly to buffered Blob playback using the unconsumed Response body.
      fallbackToBufferedResponse = true
    } else {
      // Drain any unread bytes so we can fall back seamlessly to buffered Blob playback
      // if MSE fails on MP3/ID3 chunk framing before playback started.
      try {
        while (!signal.aborted) {
          const { value, done } = await reader.read()
          if (done) break
          if (value && value.byteLength > 0) {
            const rest = new Uint8Array(value.byteLength)
            rest.set(value)
            collectedChunks.push(rest)
          }
        }
      } catch {
        // Use chunks already collected if stream draining fails.
      }
      if (collectedChunks.length > 0) {
        fallbackBlob = new Blob(collectedChunks, { type: 'audio/mpeg' })
      } else {
        throw err
      }
    }
  } finally {
    signal.removeEventListener('abort', handleAbort)
    if (reader) {
      try {
        reader.releaseLock()
      } catch {
        // Ignore already released stream lock.
      }
    }
    isPlayingSharedAudio = false
    cleanupAudioElement(audio, objectUrl)
  }

  if (fallbackToBufferedResponse) {
    await playBufferedBlob(response, signal, notifyStartedOnce)
    return
  }

  if (fallbackBlob) {
    await playBlobObject(fallbackBlob, signal, notifyStartedOnce)
  }
}

async function playBufferedBlob(
  response: Response,
  signal: AbortSignal,
  notifyStarted: () => void,
): Promise<void> {
  const onAbortWhileReading = () => {
    if (response.body) {
      void response.body.cancel().catch(() => {})
    }
  }
  signal.addEventListener('abort', onAbortWhileReading, { once: true })

  let blob: Blob
  try {
    blob = await response.blob()
  } finally {
    signal.removeEventListener('abort', onAbortWhileReading)
  }

  await playBlobObject(blob, signal, notifyStarted)
}

/**
 * Plays a streamed MP3 HTTP Response with lowest practical latency using
 * MediaSource streaming when supported, automatically recovering via full-blob
 * playback if MSE initialization/buffering fails prior to start.
 */
export async function playAudioStreamResponse(
  response: Response,
  options: PlayAudioStreamOptions,
): Promise<void> {
  const { signal, onStart } = options
  if (signal.aborted) {
    throw createAbortError()
  }

  let notified = false
  const notifyStarted = () => {
    if (!notified && !signal.aborted) {
      notified = true
      onStart()
    }
  }

  const canUseMse =
    typeof MediaSource !== 'undefined' &&
    typeof MediaSource.isTypeSupported === 'function' &&
    MediaSource.isTypeSupported('audio/mpeg') &&
    response.body !== null

  if (canUseMse) {
    await playWithMediaSourceOrFallbackBlob(response, signal, notifyStarted)
    return
  }

  await playBufferedBlob(response, signal, notifyStarted)
}
