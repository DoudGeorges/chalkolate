import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MathCorrection } from '../components/MathCorrection'

describe('MathCorrection safe rendering', () => {
  it('renders valid KaTeX with trust:false and disables unsafe commands', () => {
    const { container } = render(
      <MathCorrection
        correctionText="x^2 + 2xy + y^2"
        correctionLatex="x^2 + 2xy + y^2"
      />,
    )
    expect(container.querySelector('.katex')).not.toBeNull()

    // Unsafe \href command is blocked by trust:false (no <a> element) and falls back cleanly
    render(
      <MathCorrection
        correctionText="Safe plain correction"
        correctionLatex={String.raw`\href{javascript:alert(1)}{click}`}
      />,
    )
    expect(container.querySelector('a')).toBeNull()
    expect(screen.getByText('Safe plain correction')).toBeInTheDocument()
  })

  it('escapes HTML-like plain text and falls back on malformed LaTeX', () => {
    const { container } = render(
      <MathCorrection
        correctionText="<img src=x onerror=alert(1)>"
        correctionLatex="\\frac{unterminated"
      />,
    )
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
  })
})
