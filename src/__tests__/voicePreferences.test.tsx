import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '../api/client'
import { FindingsPanel, FindingsPanelProps } from '../components/FindingsPanel'
import { SettingsContent } from '../components/SettingsContent'
import { TopBar } from '../components/TopBar'
import { PREVIEW_ALERT_ID, useSpeechAlerts } from '../hooks/useSpeechAlerts'
import { parseVoiceLabel } from '../lib/voiceLabels'
import {
  DEFAULT_VOICE_PREFERENCES,
  MAX_SPOKEN_TEXT_CHARS,
  VOICE_PREFERENCES_STORAGE_KEY,
  VoicePreferences,
  buildBriefText,
  composeSpokenText,
  loadVoicePreferences,
  sanitizeVoicePreferences,
  saveVoicePreferences,
} from '../lib/voicePreferences'

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve()
  }
}

const ISSUE = {
  spoken_alert: 'The derivative of x squared is 2x, not x',
  explanation: 'The power rule brings the exponent down and lowers it by one.',
  category: 'math',
  correction_text: '2x',
}

describe('voice preferences', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('sanitizes, migrates legacy levels, and round-trips through localStorage', () => {
    expect(sanitizeVoicePreferences(null)).toEqual(DEFAULT_VOICE_PREFERENCES)
    expect(
      sanitizeVoicePreferences({ elevenLabsVoice: '../evil', talkativeness: 'loud' }),
    ).toEqual(DEFAULT_VOICE_PREFERENCES)
    expect(sanitizeVoicePreferences({ talkativeness: 'every' }).talkativeness).toBe('standard')
    expect(sanitizeVoicePreferences({ talkativeness: 'minimal' }).talkativeness).toBe('brief')

    const prefs: VoicePreferences = {
      elevenLabsVoice: '21m00Tcm4TlvDq8ikWAM',
      talkativeness: 'detailed',
    }
    saveVoicePreferences(prefs)
    expect(loadVoicePreferences()).toEqual(prefs)

    window.localStorage.setItem(VOICE_PREFERENCES_STORAGE_KEY, '{not json')
    expect(loadVoicePreferences()).toEqual(DEFAULT_VOICE_PREFERENCES)
  })

  it('changes how much is said about one mistake per level', () => {
    expect(composeSpokenText(ISSUE, 'brief')).toBe('Math mistake. Should be 2x.')
    expect(composeSpokenText(ISSUE, 'standard')).toBe(ISSUE.spoken_alert)
    expect(composeSpokenText(ISSUE, 'detailed')).toBe(
      'The derivative of x squared is 2x, not x. The power rule brings the exponent down and lowers it by one.',
    )

    // Long corrections are not read out in Brief mode.
    expect(buildBriefText('physics', 'F = m a where m is the total mass of both blocks')).toBe(
      'Physics mistake.',
    )
    expect(buildBriefText(undefined, undefined)).toBe('Possible mistake.')

    // Detailed text always fits the backend speech limit and ends cleanly.
    const long = composeSpokenText(
      { ...ISSUE, explanation: 'word '.repeat(100) },
      'detailed',
    )
    expect(long.length).toBeLessThanOrEqual(MAX_SPOKEN_TEXT_CHARS)
    expect(long.endsWith('.')).toBe(true)
  })

  it('parses voice labels into name, tagline, and tags', () => {
    expect(
      parseVoiceLabel({
        id: 'default',
        label: 'Default: Alice - Clear, Engaging Educator (professional, british)',
      }),
    ).toMatchObject({
      name: 'Alice',
      tagline: 'Clear, Engaging Educator',
      tags: ['professional', 'british'],
      isDefault: true,
    })
    expect(parseVoiceLabel({ id: 'v1', label: 'Adam' })).toMatchObject({
      name: 'Adam',
      tagline: '',
      tags: [],
      isDefault: false,
    })
  })
})

describe('useSpeechAlerts talkativeness and voice options', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function setup(preferences: VoicePreferences) {
    const calls: Array<{ text: string; voice?: string }> = []
    const started: string[] = []
    const hook = renderHook(
      (props: { preferences: VoicePreferences }) =>
        useSpeechAlerts({
          elevenLabsConfigured: true,
          preferences: props.preferences,
          onUtteranceStarted: (id) => started.push(id),
          deps: {
            requestSpeech: (text, _signal, options) => {
              calls.push({ text, ...options })
              return Promise.resolve(new Response('audio', { status: 200 }))
            },
            playAudio: async (_res, { onStart }) => {
              onStart()
            },
          },
        }),
      { initialProps: { preferences } },
    )
    return { ...hook, calls, started }
  }

  it('announces every mistake at every level, only changing how much is said', async () => {
    for (const [level, expected] of [
      ['brief', 'Math mistake. Should be 2x.'],
      ['standard', ISSUE.spoken_alert],
      ['detailed', composeSpokenText(ISSUE, 'detailed')],
    ] as const) {
      const { result, calls, unmount } = setup({
        ...DEFAULT_VOICE_PREFERENCES,
        elevenLabsVoice: 'daniel',
        talkativeness: level,
      })
      await act(async () => {
        result.current.enqueueAutoAlerts([
          { id: 'a', ...ISSUE },
          { id: 'b', ...ISSUE, category: 'spelling', correction_text: 'the' },
        ])
        await flush()
      })
      expect(calls).toHaveLength(2)
      expect(calls[0]).toEqual({ text: expected, voice: 'daniel' })
      unmount()
    }
  })

  it('Speak on a card gives at least the full sentence even in Brief mode', async () => {
    const { result, calls } = setup({ ...DEFAULT_VOICE_PREFERENCES, talkativeness: 'brief' })
    await act(async () => {
      result.current.speakNow({ id: 'a', ...ISSUE })
      await flush()
    })
    expect(calls.map((c) => c.text)).toEqual([ISSUE.spoken_alert])
  })

  it('blocks only the voice the account cannot use and keeps ElevenLabs for other voices', async () => {
    const voices: Array<string | undefined> = []
    const notices: string[] = []
    const { result, rerender } = renderHook(
      (props: { preferences: VoicePreferences }) =>
        useSpeechAlerts({
          elevenLabsConfigured: true,
          preferences: props.preferences,
          onProviderFallback: (reason) => notices.push(reason),
          deps: {
            requestSpeech: (_text, _signal, options) => {
              voices.push(options?.voice)
              if (options?.voice === 'paidVoice') {
                return Promise.reject(
                  new ApiClientError('Selected ElevenLabs voice requires a paid plan.', {
                    code: 'SPEECH_VOICE_PLAN_REQUIRED',
                    status: 503,
                  }),
                )
              }
              return Promise.resolve(new Response('audio', { status: 200 }))
            },
            playAudio: async (_res, { onStart }) => {
              onStart()
            },
          },
        }),
      {
        initialProps: {
          preferences: { ...DEFAULT_VOICE_PREFERENCES, elevenLabsVoice: 'paidVoice' },
        },
      },
    )

    await act(async () => {
      result.current.enqueueAutoAlerts([{ id: 'a', spoken_alert: 'First.' }])
      await flush()
    })
    await act(async () => {
      result.current.enqueueAutoAlerts([{ id: 'b', spoken_alert: 'Second.' }])
      await flush()
    })
    expect(voices).toEqual(['paidVoice'])
    expect(notices).toEqual(['Selected ElevenLabs voice requires a paid plan.'])

    rerender({ preferences: { ...DEFAULT_VOICE_PREFERENCES, elevenLabsVoice: 'freeVoice' } })
    await act(async () => {
      result.current.enqueueAutoAlerts([{ id: 'c', spoken_alert: 'Third.' }])
      await flush()
    })
    expect(voices).toEqual(['paidVoice', 'freeVoice'])
  })

  it('previews a specific voice at the current level without marking findings spoken', async () => {
    const { result, calls, started } = setup({
      ...DEFAULT_VOICE_PREFERENCES,
      talkativeness: 'brief',
    })
    await act(async () => {
      result.current.previewVoice('voiceRachel1')
      result.current.syncActiveIssueIds(new Set())
      await flush()
    })
    expect(calls).toEqual([{ text: 'Math mistake. Should be 2x.', voice: 'voiceRachel1' }])
    expect(started).not.toContain(PREVIEW_ALERT_ID)
    expect(result.current.previewingVoice).toBeNull()
  })
})

describe('Settings panel', () => {
  function renderPanel(overrides: Partial<React.ComponentProps<typeof SettingsContent>> = {}) {
    const onChange = vi.fn()
    const onPreview = vi.fn()
    const onStop = vi.fn()
    const onRetry = vi.fn()
    const onChangeAlertMode = vi.fn()
    const utils = render(
      <SettingsContent
        alertMode="voice_visual"
        onChangeAlertMode={onChangeAlertMode}
        voicePreferences={DEFAULT_VOICE_PREFERENCES}
        onChangeVoicePreferences={onChange}
        elevenLabsConfigured
        voices={[
          { id: 'default', label: 'Default: George - Warm Storyteller (british)' },
          { id: 'voiceRachel1', label: 'Rachel - Calm (american)' },
        ]}
        onPreviewVoice={onPreview}
        onStopPreview={onStop}
        onRetryVoices={onRetry}
        {...overrides}
      />,
    )
    return { ...utils, onChange, onPreview, onStop, onRetry, onChangeAlertMode }
  }

  it('selects and previews voices, and picks alert mode and how much it talks', () => {
    const { onChange, onPreview, onChangeAlertMode } = renderPanel()

    fireEvent.click(screen.getByRole('radio', { name: /Voice only/ }))
    expect(onChangeAlertMode).toHaveBeenCalledWith('voice_only')

    expect(screen.getByRole('radio', { name: 'George (default)' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    fireEvent.click(screen.getByRole('radio', { name: 'Rachel' }))
    expect(onChange).toHaveBeenLastCalledWith({ elevenLabsVoice: 'voiceRachel1' })

    fireEvent.click(screen.getByRole('button', { name: 'Preview Rachel' }))
    expect(onPreview).toHaveBeenLastCalledWith('voiceRachel1')

    fireEvent.click(screen.getByRole('radio', { name: 'Detailed' }))
    expect(onChange).toHaveBeenLastCalledWith({ talkativeness: 'detailed' })

    fireEvent.click(screen.getByRole('button', { name: /hear example/i }))
    expect(onPreview).toHaveBeenLastCalledWith('default')

    expect(screen.queryByLabelText('Speech speed')).toBeNull()
  })

  it('hides voice options when alerts are visual only', () => {
    renderPanel({ alertMode: 'visual_only' })
    expect(screen.queryByRole('radiogroup', { name: 'Voice' })).toBeNull()
    expect(screen.getByText(/hidden while alerts are visual only/i)).toBeInTheDocument()
  })

  it('moves the voice selection with arrow keys', () => {
    const { onChange } = renderPanel()
    fireEvent.keyDown(screen.getByRole('radio', { name: 'George (default)' }), {
      key: 'ArrowDown',
    })
    expect(onChange).toHaveBeenLastCalledWith({ elevenLabsVoice: 'voiceRachel1' })
  })

  it('shows a stop control while a voice is previewing', () => {
    const { onStop } = renderPanel({ previewingVoice: 'voiceRachel1' })
    fireEvent.click(screen.getByRole('button', { name: 'Stop Rachel preview' }))
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('offers Retry when voices fail to load', () => {
    const { onRetry } = renderPanel({ voices: [], voicesError: "Couldn't load voices: Not Found" })
    expect(screen.getByRole('alert')).toHaveTextContent('Not Found')
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('explains how to enable ElevenLabs when it is not configured', () => {
    renderPanel({ elevenLabsConfigured: false, voices: [] })
    expect(screen.getByText('ELEVENLABS_API_KEY')).toBeInTheDocument()
  })
})

describe('TopBar settings button', () => {
  const base = {
    mediaReady: false,
    monitoring: false,
    onToggleMonitoring: () => {},
    onToggleSettings: () => {},
  }

  it('hides Start/Stop and Settings on the landing page', () => {
    const { rerender } = render(<TopBar {...base} onboarding />)
    expect(screen.queryByRole('button', { name: /Start/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull()

    rerender(<TopBar {...base} mediaReady onboarding={false} />)
    expect(screen.getByRole('button', { name: /Start/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument()
  })

  it('offers Back to start once a source is live, but not on the landing page', () => {
    const onGoHome = vi.fn()
    const { rerender } = render(<TopBar {...base} onboarding onGoHome={onGoHome} />)
    expect(screen.queryByRole('button', { name: /back to start/i })).toBeNull()

    rerender(<TopBar {...base} mediaReady onboarding={false} onGoHome={onGoHome} />)
    fireEvent.click(screen.getByRole('button', { name: /back to start/i }))
    expect(onGoHome).toHaveBeenCalledTimes(1)
  })

  it('toggles the settings panel', () => {
    const onToggleSettings = vi.fn()
    render(
      <TopBar
        mediaReady={false}
        monitoring={false}
        onToggleMonitoring={() => {}}
        settingsOpen={false}
        onToggleSettings={onToggleSettings}
      />,
    )
    const button = screen.getByRole('button', { name: 'Settings' })
    expect(button).toHaveAttribute('aria-controls', 'findings-sidebar-content')
    fireEvent.click(button)
    expect(onToggleSettings).toHaveBeenCalledTimes(1)
  })
})

describe('Right side panel with Findings and Settings tabs', () => {
  const base: FindingsPanelProps = {
    open: true,
    monitoring: true,
    onToggle: () => {},
    onClose: () => {},
    hasAnalyzed: false,
    openIssues: [],
    dismissedCount: 0,
    selectedIssueId: null,
    hoveredIssueId: null,
    speechSupported: true,
    pulseBadge: false,
    onSelectIssue: () => {},
    onHoverIssue: () => {},
    onSpeakIssue: () => {},
    onMarkFixed: () => {},
    onDismissIssue: () => {},
    onRestoreDismissed: () => {},
    settingsContent: <p>Settings body</p>,
  }

  it('stacks Findings and Settings as tabs in one panel', () => {
    const onChangeTab = vi.fn()
    const { rerender } = render(<FindingsPanel {...base} tab="findings" onChangeTab={onChangeTab} />)
    expect(screen.getByRole('tab', { name: /Findings/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Watching the board')).toBeInTheDocument()
    expect(screen.queryByText('Settings body')).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: /Settings/ }))
    expect(onChangeTab).toHaveBeenCalledWith('settings')

    rerender(<FindingsPanel {...base} tab="settings" onChangeTab={onChangeTab} />)
    expect(screen.getByRole('tab', { name: /Settings/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Settings body')).toBeInTheDocument()
    expect(screen.queryByText('Watching the board')).toBeNull()
  })

  it('shows only Settings in voice-only mode', () => {
    render(<FindingsPanel {...base} tab="findings" findingsEnabled={false} />)
    expect(screen.queryByRole('tab', { name: /Findings/ })).toBeNull()
    expect(screen.getByRole('tab', { name: /Settings/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Settings body')).toBeInTheDocument()
  })
})
