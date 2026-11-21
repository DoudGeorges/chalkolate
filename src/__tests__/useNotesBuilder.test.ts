import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotesMetadataPayload, NotesResponse } from '../api/schemas'
import { NotesBuilderDeps, useNotesBuilder } from '../hooks/useNotesBuilder'
import { GrayscaleSample } from '../lib/frameCapture'
import { createEmptyNotes } from '../lib/notes'
import { NOTES_SAMPLE_INTERVAL_MS } from '../lib/notesTrigger'

function frame(fill: number, blockValue?: number): GrayscaleSample {
  const data = new Uint8Array(160 * 96).fill(fill)
  if (blockValue !== undefined) {
    for (let y = 0; y < 48; y++) for (let x = 0; x < 80; x++) data[y * 160 + x] = blockValue
  }
  return { width: 160, height: 96, data }
}

function response(id: string, meta: NotesMetadataPayload): NotesResponse {
  return {
    request_id: meta.request_id,
    lecture_title: 'Lecture',
    updates: [{ id, heading: `H ${id}`, body_markdown: `$x_${id}$`, has_figure: false, figure_box_2d: null, after_section_id: null }],
    latency_ms: 5,
  }
}

describe('useNotesBuilder', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function setup(
    initial: GrayscaleSample,
    failWith?: () => Error,
  ) {
    let clock = 1_000_000
    let seq = 0
    let current = initial
    const requests: NotesMetadataPayload[] = []
    const persisted: unknown[] = []
    const blobSizes: number[] = []
    let captures = 0
    const deps: Partial<NotesBuilderDeps> = {
      now: () => clock,
      createUuid: () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
      sampleFrame: () => current,
      captureSnapshot: async () => ({ blob: new Blob(['c'.repeat(++captures)]) }),
      requestNotes: async (b, meta) => {
        requests.push(meta)
        blobSizes.push(b.size)
        if (failWith) throw failWith()
        return response(`s${requests.length}`, meta)
      },
      makeThumbnail: async () => null,
      loadInitial: () => createEmptyNotes(),
      persist: (doc) => void persisted.push(doc),
    }
    const source = document.createElement('canvas')
    const hook = renderHook(
      (p: { enabled: boolean }) =>
        useNotesBuilder({
          mediaSource: source,
          mediaReady: true,
          sourceGeneration: 1,
          enabled: p.enabled,
          calibrationEditing: false,
          committedCorners: null,
          deps,
        }),
      { initialProps: { enabled: false } },
    )
    const advance = async (ms: number) => {
      for (let t = 0; t < ms; t += NOTES_SAMPLE_INTERVAL_MS) {
        await act(async () => {
          clock += NOTES_SAMPLE_INTERVAL_MS
          vi.advanceTimersByTime(NOTES_SAMPLE_INTERVAL_MS)
          for (let i = 0; i < 6; i++) await Promise.resolve()
        })
      }
    }
    return { hook, requests, persisted, blobSizes, advance, setFrame: (f: GrayscaleSample) => (current = f) }
  }

  it('does nothing until enabled, then snapshots once and stays quiet on a static board', async () => {
    const { hook, requests, advance } = setup(frame(30))
    await advance(5000)
    expect(requests).toHaveLength(0)

    await act(async () => hook.rerender({ enabled: true }))
    await advance(6000)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.sections).toEqual([])
    expect(hook.result.current.notes.sections.map((s) => s.id)).toEqual(['s1'])
    expect(hook.result.current.notes.title).toBe('Lecture')

    await advance(30_000)
    expect(requests).toHaveLength(1)
  })

  it('sends accumulated notes as context and persists on a later significant change', async () => {
    const { hook, requests, persisted, advance, setFrame } = setup(frame(30))
    await act(async () => hook.rerender({ enabled: true }))
    await advance(6000)
    expect(requests).toHaveLength(1)

    setFrame(frame(30, 200))
    await advance(25_000)
    expect(requests).toHaveLength(2)
    expect(requests[1]?.sections.map((s) => s.id)).toEqual(['s1'])
    expect(hook.result.current.notes.sections).toHaveLength(2)
    expect(persisted.length).toBeGreaterThanOrEqual(2)
  })

  it('surfaces failures, keeps notes, and backs off before retrying', async () => {
    const { hook, requests, advance } = setup(frame(30), () => new Error('upstream down'))
    await act(async () => hook.rerender({ enabled: true }))
    await advance(3000)
    expect(requests).toHaveLength(1)
    expect(hook.result.current.error).toBe('upstream down')
    expect(hook.result.current.notes.sections).toHaveLength(0)
    await advance(5000)
    expect(requests).toHaveLength(1)
    await advance(8000)
    expect(requests.length).toBeGreaterThanOrEqual(2)
  })

  it('flushes the last stable frame before it is erased', async () => {
    const { hook, requests, blobSizes, advance, setFrame } = setup(frame(30))
    await act(async () => hook.rerender({ enabled: true }))
    await advance(6000)
    expect(requests).toHaveLength(1)

    const small = frame(30)
    for (let y = 0; y < 16; y++) for (let x = 0; x < 32; x++) small.data[y * 160 + x] = 200
    setFrame(small)
    await advance(4000) // calm, minor change: retained as stable candidate (capture #2)
    expect(requests).toHaveLength(1)

    setFrame(frame(30, 200)) // large change shortly after: previous stable must be sent first
    await advance(6000)
    expect(requests).toHaveLength(2)
    expect(blobSizes[1]).toBe(2)
  })

  it('clear empties notes and resets tracking', async () => {
    const { hook, advance } = setup(frame(30))
    await act(async () => hook.rerender({ enabled: true }))
    await advance(6000)
    expect(hook.result.current.notes.sections).toHaveLength(1)
    act(() => hook.result.current.clear())
    expect(hook.result.current.notes.sections).toHaveLength(0)
  })
})
