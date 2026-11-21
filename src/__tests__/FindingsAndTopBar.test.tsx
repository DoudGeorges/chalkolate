import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DetectionOverlay } from '../components/DetectionOverlay'
import { FindingsPanel } from '../components/FindingsPanel'
import { IssueCard } from '../components/IssueCard'
import { TopBar } from '../components/TopBar'
import { TrackedIssue } from '../lib/issueTracker'

function makeIssue(overrides: Partial<TrackedIssue> = {}): TrackedIssue {
  return {
    id: 'issue-1',
    category: 'physics',
    detected_text: 'F = 10 N/m',
    normalized_text: 'F = 10 N/m',
    compact_text: 'F=10N/m',
    correction_text: 'F = 10 N',
    correction_latex: null,
    spoken_alert: 'Force should be in Newtons.',
    explanation: 'Mass times acceleration yields Newtons.',
    box_2d: [100, 100, 200, 300],
    confidence: 0.94,
    status: 'open',
    missCount: 0,
    needsRecheck: false,
    firstSeenSeq: 1,
    lastSeenSeq: 1,
    lastSeenSample: null,
    spoken: false,
    pendingVerification: false,
    ...overrides,
  }
}

describe('FindingsPanel, IssueCard, and TopBar refinements', () => {
  it('omits confidence scores from IssueCard and omits informational footer text from FindingsPanel', () => {
    const issue = makeIssue()
    const { container } = render(
      <IssueCard
        issue={issue}
        isSelected={false}
        isHovered={false}
        speechSupported={true}
        onSelect={vi.fn()}
        onHover={vi.fn()}
        onSpeak={vi.fn()}
        onMarkFixed={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )

    expect(container.textContent).not.toMatch(/confidence/i)
    expect(container.textContent).not.toContain('94%')
    expect(screen.getByText('Physics')).toBeTruthy()
    expect(screen.getByText('F = 10 N/m')).toBeTruthy()
    expect(screen.getByText('F = 10 N')).toBeTruthy()

    const { rerender } = render(
      <FindingsPanel
        open={true}
        monitoring={false}
        onToggle={vi.fn()}
        onClose={vi.fn()}
        hasAnalyzed={false}
        openIssues={[]}
        dismissedCount={0}
        selectedIssueId={null}
        hoveredIssueId={null}
        speechSupported={true}
        pulseBadge={false}
        onSelectIssue={vi.fn()}
        onHoverIssue={vi.fn()}
        onSpeakIssue={vi.fn()}
        onMarkFixed={vi.fn()}
        onDismissIssue={vi.fn()}
        onRestoreDismissed={vi.fn()}
      />,
    )
    expect(screen.getByText('Monitoring paused')).toBeTruthy()

    rerender(
      <FindingsPanel
        open={true}
        monitoring={true}
        onToggle={vi.fn()}
        onClose={vi.fn()}
        hasAnalyzed={true}
        openIssues={[]}
        dismissedCount={0}
        selectedIssueId={null}
        hoveredIssueId={null}
        speechSupported={true}
        pulseBadge={false}
        onSelectIssue={vi.fn()}
        onHoverIssue={vi.fn()}
        onSpeakIssue={vi.fn()}
        onMarkFixed={vi.fn()}
        onDismissIssue={vi.fn()}
        onRestoreDismissed={vi.fn()}
      />,
    )
    expect(screen.getByText('Board looks clear')).toBeTruthy()
    expect(screen.getByText('No math, physics, or spelling mistakes detected.')).toBeTruthy()
  })

  it('keeps the TopBar minimal with no Camera/Screen/Upload source buttons', () => {
    render(<TopBar mediaReady monitoring={false} onToggleMonitoring={vi.fn()} />)
    expect(screen.queryByRole('group', { name: 'Board source' })).toBeNull()
    for (const name of ['Camera', 'Screen', 'Upload', 'Select camera device']) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
    expect(screen.getByRole('button', { name: /Start/ })).toBeEnabled()
  })

  it('toggles FindingsPanel on click in both collapsed and expanded states on a solid surface without glass blur', () => {
    const onToggle = vi.fn()
    const baseProps = {
      monitoring: false,
      onToggle,
      onClose: vi.fn(),
      hasAnalyzed: false,
      openIssues: [],
      dismissedCount: 0,
      selectedIssueId: null,
      hoveredIssueId: null,
      speechSupported: true,
      pulseBadge: false,
      onSelectIssue: vi.fn(),
      onHoverIssue: vi.fn(),
      onSpeakIssue: vi.fn(),
      onMarkFixed: vi.fn(),
      onDismissIssue: vi.fn(),
      onRestoreDismissed: vi.fn(),
    }

    const { container, rerender } = render(<FindingsPanel open={false} {...baseProps} />)

    const wrapper = screen.getByTestId('findings-panel-container')
    const sidebar = container.querySelector('#findings-sidebar-content')
    const toggleBtn = screen.getByRole('button', { name: 'Expand findings panel' })

    expect(wrapper.className).not.toContain('backdrop-blur')
    expect(sidebar?.className).not.toContain('backdrop-blur')
    expect(sidebar?.className).toContain('bg-white')
    expect(toggleBtn.className).toContain('pointer-events-auto')
    expect(toggleBtn.getAttribute('aria-controls')).toBe('findings-sidebar-content')

    fireEvent.click(toggleBtn)
    expect(onToggle).toHaveBeenCalledTimes(1)

    rerender(<FindingsPanel open={true} {...baseProps} />)
    const collapseBtn = screen.getByRole('button', { name: 'Collapse findings panel' })
    fireEvent.click(collapseBtn)
    expect(onToggle).toHaveBeenCalledTimes(2)
  })

  it('never renders a relocating findings banner or hides pills on DetectionOverlay', () => {
    render(
      <DetectionOverlay
        imageRect={{ left: 0, top: 0, width: 800, height: 600 }}
        issues={[makeIssue()]}
        locationsUnverified={true}
        selectedIssueId={null}
        hoveredIssueId={null}
        onSelectIssue={vi.fn()}
        onHoverIssue={vi.fn()}
      />,
    )
    expect(screen.queryByText(/re-locating/i)).toBeNull()
    expect(screen.getByText('F = 10 N')).toBeTruthy()
  })
})
