import { AlertCircle, Check, Play, RotateCw, Search, Volume2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { SpeechVoiceOption } from '../api/schemas'
import { VoiceDisplay, parseVoiceLabel, voiceHue } from '../lib/voiceLabels'
import { VoicePreferences } from '../lib/voicePreferences'

export interface VoiceSettingsProps {
  preferences: VoicePreferences
  onChange: (patch: Partial<VoicePreferences>) => void
  elevenLabsConfigured: boolean
  voices: readonly SpeechVoiceOption[]
  voicesLoading?: boolean
  voicesError?: string | null
  onRetryVoices?: () => void
  /** Voice key currently previewing, or null. */
  previewingVoice?: string | null
  onPreviewVoice?: (voice?: string) => void
  onStopPreview?: () => void
}

const SEARCH_THRESHOLD = 6

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
      {children}
    </div>
  )
}

function EqualizerBars() {
  return (
    <span className="flex h-3 items-end gap-[2px]" aria-hidden="true">
      <span className="eq-bar w-[2px] rounded-full bg-current" />
      <span className="eq-bar w-[2px] rounded-full bg-current [animation-delay:-0.3s]" />
      <span className="eq-bar w-[2px] rounded-full bg-current [animation-delay:-0.6s]" />
    </span>
  )
}

function VoiceAvatar({ name }: { name: string }) {
  const hue = voiceHue(name)
  return (
    <span
      aria-hidden="true"
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
      style={{
        backgroundColor: `hsl(${hue} 55% 93%)`,
        color: `hsl(${hue} 45% 32%)`,
      }}
    >
      {name.charAt(0).toUpperCase()}
    </span>
  )
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
  const rowRefs = useRef<Map<string, HTMLButtonElement>>(new Map())

  const displayVoices = useMemo<VoiceDisplay[]>(() => voices.map(parseVoiceLabel), [voices])
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return displayVoices
    return displayVoices.filter((v) => v.searchText.includes(q))
  }, [displayVoices, query])

  const selectedId = preferences.elevenLabsVoice
  const selectedVoice = displayVoices.find((v) => v.id === selectedId)

  // Bring the current voice into view when the list first renders.
  useEffect(() => {
    const row = rowRefs.current.get(selectedId)
    if (row && typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ block: 'nearest' })
    }
    // Only on list (re)population, not on every selection change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayVoices.length])

  const selectVoice = (id: string, focus = false) => {
    onChange({ elevenLabsVoice: id })
    if (focus) {
      const row = rowRefs.current.get(id)
      row?.focus()
      if (row && typeof row.scrollIntoView === 'function') {
        row.scrollIntoView({ block: 'nearest' })
      }
    }
  }

  const handleListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (filtered.length === 0) return
    const index = Math.max(
      0,
      filtered.findIndex((v) => v.id === selectedId),
    )
    let next: number | null = null
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = index + 1
    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = index - 1
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = filtered.length - 1
    if (next === null) return
    event.preventDefault()
    const wrapped = (next + filtered.length) % filtered.length
    const target = filtered[wrapped]
    if (target) selectVoice(target.id, true)
  }

  const togglePreview = (id: string) => {
    if (previewingVoice === id) {
      onStopPreview?.()
    } else {
      onPreviewVoice?.(id)
    }
  }

  const focusableId = filtered.some((v) => v.id === selectedId) ? selectedId : filtered[0]?.id

  return (
    <section className="space-y-2">
        <SectionLabel>Voice</SectionLabel>

        {!elevenLabsConfigured ? (
          <div className="flex items-start gap-3 rounded-lg border border-line bg-zinc-50 p-3">
            <Volume2 className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" aria-hidden="true" />
            <div className="min-w-0 flex-1 space-y-2">
              <p className="text-[11px] leading-snug text-zinc-500">
                Alerts use your browser&apos;s built-in voice. Add{' '}
                <code className="rounded bg-zinc-100 px-1 text-zinc-700">
                  ELEVENLABS_API_KEY
                </code>{' '}
                to the backend to choose a natural ElevenLabs voice.
              </p>
              {onPreviewVoice && (
                <button
                  type="button"
                  onClick={() => togglePreview(selectedId)}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line bg-zinc-50 px-2.5 text-xs text-zinc-800 transition hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                >
                  {previewingVoice ? (
                    <EqualizerBars />
                  ) : (
                    <Play className="h-3 w-3 fill-current" aria-hidden="true" />
                  )}
                  {previewingVoice ? 'Stop' : 'Test voice'}
                </button>
              )}
            </div>
          </div>
        ) : voicesError && displayVoices.length === 0 ? (
          <div
            role="alert"
            className="flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 p-3"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
            <div className="min-w-0 flex-1 space-y-2">
              <p className="text-[11px] leading-snug text-amber-900">{voicesError}</p>
              {onRetryVoices && (
                <button
                  type="button"
                  onClick={onRetryVoices}
                  className="inline-flex h-6 items-center gap-1 rounded-md border border-amber-300 px-2 text-[11px] font-medium text-amber-900 transition hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
                >
                  <RotateCw className="h-3 w-3" aria-hidden="true" />
                  Retry
                </button>
              )}
            </div>
          </div>
        ) : (
          <>
            {displayVoices.length > SEARCH_THRESHOLD && (
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500"
                  aria-hidden="true"
                />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={`Search ${displayVoices.length} voices`}
                  aria-label="Search voices"
                  className="h-8 w-full rounded-lg border border-line bg-zinc-100 pl-8 pr-7 text-xs text-zinc-900 placeholder:text-zinc-500 focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 [&::-webkit-search-cancel-button]:hidden"
                />
                {query && (
                  <button
                    type="button"
                    aria-label="Clear search"
                    onClick={() => setQuery('')}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-zinc-500 transition hover:text-zinc-800"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                )}
              </div>
            )}

            <div
              role="radiogroup"
              aria-label="Voice"
              onKeyDown={handleListKeyDown}
              className="max-h-64 overflow-y-auto overscroll-contain rounded-lg border border-line bg-white p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              {voicesLoading && displayVoices.length === 0 ? (
                <div aria-label="Loading voices" className="space-y-1">
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="flex items-center gap-2.5 px-2 py-1.5">
                      <span className="h-8 w-8 animate-pulse rounded-full bg-zinc-100" />
                      <span className="flex-1 space-y-1.5">
                        <span className="block h-2.5 w-24 animate-pulse rounded bg-zinc-100" />
                        <span className="block h-2 w-36 animate-pulse rounded bg-zinc-100" />
                      </span>
                    </div>
                  ))}
                </div>
              ) : filtered.length === 0 ? (
                <p className="px-2 py-6 text-center text-[11px] text-zinc-500">
                  {query ? `No voices match “${query}”` : 'No voices available'}
                </p>
              ) : (
                filtered.map((voice) => {
                  const selected = voice.id === selectedId
                  const previewing = previewingVoice === voice.id
                  const subtitle = [voice.tagline, ...voice.tags].filter(Boolean).join(' · ')
                  return (
                    <div
                      key={voice.id}
                      className={`group flex items-center gap-1 rounded-md transition-colors ${
                        selected ? 'bg-accent/[0.09]' : 'hover:bg-zinc-100'
                      }`}
                    >
                      <button
                        ref={(el) => {
                          if (el) rowRefs.current.set(voice.id, el)
                          else rowRefs.current.delete(voice.id)
                        }}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        aria-label={voice.isDefault ? `${voice.name} (default)` : voice.name}
                        tabIndex={voice.id === focusableId ? 0 : -1}
                        onClick={() => selectVoice(voice.id)}
                        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                      >
                        <VoiceAvatar name={voice.name} />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span
                              className={`truncate text-xs font-medium ${
                                selected ? 'text-zinc-950' : 'text-zinc-800'
                              }`}
                            >
                              {voice.name}
                            </span>
                            {voice.isDefault && (
                              <span className="shrink-0 rounded bg-zinc-100 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-zinc-500">
                                Default
                              </span>
                            )}
                          </span>
                          {subtitle && (
                            <span className="block truncate text-[11px] capitalize text-zinc-500">
                              {subtitle}
                            </span>
                          )}
                        </span>
                        <Check
                          className={`h-3.5 w-3.5 shrink-0 text-accent transition-opacity ${
                            selected ? 'opacity-100' : 'opacity-0'
                          }`}
                          aria-hidden="true"
                        />
                      </button>
                      {onPreviewVoice && (
                        <button
                          type="button"
                          aria-label={previewing ? `Stop ${voice.name} preview` : `Preview ${voice.name}`}
                          title={previewing ? 'Stop' : 'Preview'}
                          onClick={() => togglePreview(voice.id)}
                          className={`mr-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
                            previewing
                              ? 'bg-accent text-white'
                              : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 group-hover:text-zinc-700'
                          }`}
                        >
                          {previewing ? (
                            <EqualizerBars />
                          ) : (
                            <Play className="h-3 w-3 translate-x-px fill-current" aria-hidden="true" />
                          )}
                        </button>
                      )}
                    </div>
                  )
                })
              )}
            </div>

            {voicesError && displayVoices.length > 0 && (
              <p className="text-[11px] text-amber-700">{voicesError}</p>
            )}
            {selectedVoice && !query && (
              <p className="sr-only" aria-live="polite">
                Selected voice: {selectedVoice.name}
              </p>
            )}
          </>
        )}
    </section>
  )
}
