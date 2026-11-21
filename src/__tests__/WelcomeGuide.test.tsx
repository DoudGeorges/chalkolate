import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { WelcomeGuide, WelcomeGuideProps } from '../components/WelcomeGuide'

function renderGuide(overrides: Partial<WelcomeGuideProps> = {}) {
  const props: WelcomeGuideProps = {
    onLaunch: vi.fn(),
    voiceName: 'Anuj',
    talkativeness: 'standard',
    onChangeTalkativeness: vi.fn(),
    alertMode: 'voice_visual',
    onChangeAlertMode: vi.fn(),
    onOpenSettings: vi.fn(),
    onPreviewVoice: vi.fn(),
    onStopPreview: vi.fn(),
    ...overrides,
  }
  const utils = render(<WelcomeGuide {...props} />)
  return { ...utils, props }
}

describe('WelcomeGuide', () => {
  it('does not open anything until a source is chosen and Start is pressed', () => {
    const { props } = renderGuide()
    expect(screen.getAllByRole('listitem')).toHaveLength(3)

    const start = screen.getByRole('button', { name: 'Start' })
    expect(start).toBeDisabled()
    fireEvent.click(start)
    expect(props.onLaunch).not.toHaveBeenCalled()

    // Picking a source only selects it.
    fireEvent.click(screen.getByRole('radio', { name: /Camera/ }))
    expect(props.onLaunch).not.toHaveBeenCalled()
    expect(screen.getByRole('radio', { name: /Camera/ })).toHaveAttribute('aria-checked', 'true')

    fireEvent.click(screen.getByRole('button', { name: 'Start with camera' }))
    expect(props.onLaunch).toHaveBeenCalledWith('camera')
  })

  it('launches screen share from Start', () => {
    const { props } = renderGuide()
    fireEvent.click(screen.getByRole('radio', { name: /Screen/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Start with screen share' }))
    expect(props.onLaunch).toHaveBeenCalledWith('screen')
  })

  it('opens the file picker from Start and launches once a file is chosen', () => {
    const { props } = renderGuide()
    fireEvent.click(screen.getByRole('radio', { name: /Upload/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Choose a file to start' }))
    expect(props.onLaunch).not.toHaveBeenCalled()

    const file = new File(['x'], 'lecture.mp4', { type: 'video/mp4' })
    fireEvent.change(screen.getByLabelText('Upload lecture video or image'), {
      target: { files: [file] },
    })
    expect(props.onLaunch).toHaveBeenCalledWith('upload', file)
  })

  it('shows a disabled Starting state while the source opens', () => {
    renderGuide({ launching: true })
    expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled()
  })

  it('lets you hear and change the voice and pick how much it talks inline', () => {
    const { props } = renderGuide()
    expect(screen.getByText('Anuj')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Standard' })).toHaveAttribute('aria-checked', 'true')

    fireEvent.click(screen.getByRole('radio', { name: 'Detailed' }))
    expect(props.onChangeTalkativeness).toHaveBeenCalledWith('detailed')

    fireEvent.click(screen.getByRole('button', { name: /hear it/i }))
    expect(props.onPreviewVoice).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: /change voice/i }))
    expect(props.onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('opens a voice dropdown in place instead of the settings panel', () => {
    const { props } = renderGuide({
      renderVoiceMenu: (close) => (
        <div>
          <p>Voice list here</p>
          <button type="button" onClick={close}>
            Done
          </button>
        </div>
      ),
    })
    const trigger = screen.getByRole('button', { name: /change voice/i })
    fireEvent.click(trigger)
    expect(screen.getByRole('dialog', { name: 'Choose a voice' })).toHaveTextContent(
      'Voice list here',
    )
    expect(props.onOpenSettings).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('dialog', { name: 'Choose a voice' })).toBeNull()

    fireEvent.click(trigger)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Choose a voice' })).toBeNull()
  })

  it('chooses the alert mode in step 2, with Start as the footer', () => {
    const { props } = renderGuide()
    expect(screen.queryByText('Start checking')).toBeNull()
    expect(screen.getByText('Choose an alert mode')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Voice \+ Visual/ })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    fireEvent.click(screen.getByRole('radio', { name: /Voice only/ }))
    expect(props.onChangeAlertMode).toHaveBeenCalledWith('voice_only')
    expect(props.onLaunch).not.toHaveBeenCalled()
  })

  it('points to step 2 when voice is off in visual-only mode', () => {
    renderGuide({ voiceName: null, alertMode: 'visual_only' })
    expect(screen.getByText(/Voice is off in Visual only mode/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /hear it/i })).toBeNull()
    expect(screen.queryByRole('radiogroup', { name: 'Talkativeness' })).toBeNull()
  })
})
