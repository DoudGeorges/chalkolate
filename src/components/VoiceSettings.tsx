import { AudioLines, Check, CircleAlert, LoaderCircle, Play, RotateCw, Search, Square, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { SpeechVoiceOption } from '../api/schemas'
import { parseVoiceLabel } from '../lib/voiceLabels'
import { VoicePreferences } from '../lib/voicePreferences'

export interface VoiceSettingsProps {
  preferences: VoicePreferences
  onChange: (patch: Partial<VoicePreferences>) => void
  elevenLabsConfigured: boolean
  voices: readonly SpeechVoiceOption[]
  voicesLoading?: boolean
  voicesError?: string | null
  onRetryVoices?: () => void
  previewingVoice?: string | null
  onPreviewVoice?: (voice?: string) => void
  onStopPreview?: () => void
}

function scrollWithinList(list: HTMLDivElement | null, row: HTMLButtonElement | undefined) {
  if (!list || !row) return
  const viewport = list.getBoundingClientRect()
  const item = row.getBoundingClientRect()
  if (item.top < viewport.top) list.scrollTop += item.top - viewport.top
  else if (item.bottom > viewport.bottom) list.scrollTop += item.bottom - viewport.bottom
}

export function VoiceSettings({
  preferences,
  onChange,
  elevenLabsConfigured,
  voices,
  voicesLoading = false,
  voicesError = null,
  onRetryVoices,
  previewingVoice = null,
  onPreviewVoice,
  onStopPreview,
}: VoiceSettingsProps) {
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const rows = useRef(new Map<string, HTMLButtonElement>())
  const displayVoices = useMemo(() => voices.map(parseVoiceLabel), [voices])
  const search = query.trim().toLowerCase()
  const filtered = displayVoices.filter((voice) => voice.searchText.includes(search))
  const selectedId = preferences.elevenLabsVoice
  const focusableId = filtered.some((voice) => voice.id === selectedId) ? selectedId : filtered[0]?.id

  useEffect(() => {
    scrollWithinList(listRef.current, rows.current.get(selectedId))
  }, [displayVoices, selectedId])

  const togglePreview = (id: string) => {
    if (previewingVoice === id) onStopPreview?.()
    else onPreviewVoice?.(id)
  }

  const handleListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLElement) || event.target.getAttribute('role') !== 'radio') return
    const index = Math.max(0, filtered.findIndex((voice) => voice.id === selectedId))
    let next: number
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        next = index + 1
        break
      case 'ArrowUp':
      case 'ArrowLeft':
        next = index - 1
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = filtered.length - 1
        break
      default:
        return
    }
    const voice = filtered[(next + filtered.length) % filtered.length]
    if (!voice) return
    event.preventDefault()
    onChange({ elevenLabsVoice: voice.id })
    const row = rows.current.get(voice.id)
    row?.focus({ preventScroll: true })
    scrollWithinList(listRef.current, row)
  }

  return (
    <section className="space-y-2">
      <h3 className="ui-label">Voice</h3>
      {!elevenLabsConfigured ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface p-3">
          <AudioLines className="size-4 shrink-0 text-accent" aria-hidden="true" />
          <p className="min-w-0 flex-1 text-sm text-muted">
            {onPreviewVoice ? 'Browser voice' : 'This browser has no voice available.'}
          </p>
          {onPreviewVoice && (
            <button type="button" onClick={() => togglePreview(selectedId)} className="ui-button ui-compact">
              {previewingVoice ? <Square aria-hidden="true" /> : <Play aria-hidden="true" />}
              {previewingVoice ? 'Stop sample' : 'Play sample'}
            </button>
          )}
        </div>
      ) : (
        <>
          {displayVoices.length >= 6 && (
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search voices"
                aria-label="Search voices"
                className="ui-field pr-9 pl-9 [&::-webkit-search-cancel-button]:hidden"
              />
              {query && (
                <button
                  type="button"
                  aria-label="Clear voice search"
                  onClick={() => {
                    setQuery('')
                    searchRef.current?.focus()
                  }}
                  className="ui-icon absolute top-1/2 right-0.5 size-8 -translate-y-1/2"
                >
                  <X aria-hidden="true" />
                </button>
              )}
            </div>
          )}

          {voicesError && (
            <div role="alert" className="flex items-start gap-2.5 rounded-xl border border-warn-line bg-warn-soft p-3 text-xs text-warn">
              <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <div>
                <p className="leading-relaxed">{voicesError}</p>
                {onRetryVoices && (
                  <button type="button" onClick={onRetryVoices} className="ui-button ui-compact mt-2">
                    <RotateCw aria-hidden="true" /> Retry
                  </button>
                )}
              </div>
            </div>
          )}

          {voicesLoading && displayVoices.length === 0 ? (
            <p role="status" className="flex items-center gap-2 rounded-xl border border-dashed border-line p-3 text-xs text-muted">
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              Loading voices…
            </p>
          ) : filtered.length > 0 ? (
            <div
              ref={listRef}
              role="radiogroup"
              aria-label="Voice"
              onKeyDown={handleListKeyDown}
              className="max-h-56 space-y-1 overflow-y-auto overscroll-contain rounded-lg border border-line bg-panel p-1"
            >
              {filtered.map((voice) => {
                const selected = voice.id === selectedId
                const previewing = previewingVoice === voice.id
                const subtitle = [voice.tagline, ...voice.tags].filter(Boolean).join(' · ')
                const sampleName = voice.isDefault ? 'the default voice' : voice.name
                return (
                  <div
                    key={voice.id}
                    className={selected ? 'flex items-center gap-1 rounded-lg bg-accent-soft transition-colors' : 'flex items-center gap-1 rounded-lg transition-colors hover:bg-sunken'}
                  >
                    <button
                      ref={(row) => {
                        if (row) rows.current.set(voice.id, row)
                        else rows.current.delete(voice.id)
                      }}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      tabIndex={voice.id === focusableId ? 0 : -1}
                      onClick={() => onChange({ elevenLabsVoice: voice.id })}
                      className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1 text-left"
                    >
                      <span className="grid size-7 shrink-0 place-items-center rounded-full bg-sunken text-xs font-semibold text-accent" aria-hidden="true">
                        {voice.name.charAt(0).toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-sm font-medium text-ink">{voice.name}</span>
                          {voice.isDefault && voice.name !== 'Default voice' && <span className="text-xs text-muted">Default</span>}
                        </span>
                        {subtitle && <span className="block truncate text-xs text-muted">{subtitle}</span>}
                      </span>
                      {selected && <Check className="size-3.5 shrink-0 text-accent" aria-hidden="true" />}
                    </button>
                    {onPreviewVoice && (
                      <button
                        type="button"
                        aria-label={(previewing ? 'Stop' : 'Play') + ' voice sample for ' + sampleName}
                        title={previewing ? 'Stop sample' : 'Play sample'}
                        onClick={() => togglePreview(voice.id)}
                        className={previewing ? 'ui-icon mr-0.5 size-8 bg-accent text-white hover:bg-accent-hover hover:text-white' : 'ui-icon mr-0.5 size-8'}
                      >
                        {previewing ? <Square aria-hidden="true" /> : <Play aria-hidden="true" />}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          ) : !voicesError ? (
            <p role="status" className="rounded-xl border border-dashed border-line p-3 text-xs text-muted">
              {search ? 'No voices match your search.' : 'No voices are available.'}
            </p>
          ) : null}
        </>
      )}
    </section>
  )
}
