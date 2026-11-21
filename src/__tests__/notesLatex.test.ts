import { describe, expect, it } from 'vitest'
import { exportLatex } from '../lib/notesLatex'

describe('exportLatex', () => {
  it('keeps math verbatim, escapes text, and converts lists and emphasis', () => {
    const tex = exportLatex(
      {
        title: 'Fun & Games',
        sections: [
          {
            id: 'a',
            heading: 'Cost 50% #1',
            body_markdown:
              'Let $x_1^2$ be **big** and a_b.\n\n$$\\int_0^1 f\\,dx$$\n\n- one\n- two',
            figure: 'data:image/jpeg;base64,AA',
            updatedAt: 0,
          },
        ],
      },
      new Date('2026-01-02T00:00:00Z'),
    )
    expect(tex).toContain('\\title{Fun \\& Games}')
    expect(tex).toContain('\\section*{Cost 50\\% \\#1}')
    expect(tex).toContain('$x_1^2$')
    expect(tex).toContain('\\[\\int_0^1 f\\,dx\\]')
    expect(tex).toContain('\\textbf{big}')
    expect(tex).toContain('a\\_b')
    expect(tex).toContain('\\begin{itemize}')
    expect(tex).toContain('Board figure omitted')
    expect(tex).not.toContain('data:image')
    expect(tex).toContain('\\end{document}')
  })

  it('escapes backslashes in prose', () => {
    const tex = exportLatex({
      title: '',
      sections: [{ id: 'a', heading: 'h', body_markdown: 'a \\ b ~ c', figure: null, updatedAt: 0 }],
    })
    expect(tex).toContain('a \\textbackslash{} b \\textasciitilde{} c')
  })

  it('writes an unsupported command as text and preserves standard formulas', () => {
    const tex = exportLatex({
      title: '',
      sections: [{
        id: 'a', heading: 'Math', figure: null, updatedAt: 0,
        body_markdown: 'Compare $\\custom{a}$ with $\\frac{2}{3}$.',
      }],
    })
    expect(tex).toContain('\\texttt{\\textbackslash{}custom\\{a\\}}')
    expect(tex).toContain('$\\frac{2}{3}$')
  })
})
