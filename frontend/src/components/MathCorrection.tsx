import { useMemo } from 'react'
import katex from 'katex'

export interface MathCorrectionProps {
  correctionText: string
  correctionLatex: string | null
  className?: string
}

const KATEX_ERROR_SENTINEL = '#cc0001'

const KATEX_OPTIONS = {
  displayMode: false,
  throwOnError: true,
  trust: false,
  maxSize: 10,
  maxExpand: 200,
  strict: 'ignore' as const,
  errorColor: KATEX_ERROR_SENTINEL,
}

export function MathCorrection({
  correctionText,
  correctionLatex,
  className = '',
}: MathCorrectionProps) {
  const renderedHtml = useMemo<string | null>(() => {
    if (!correctionLatex) return null
    const trimmed = correctionLatex.trim()
    if (!trimmed) return null
    try {
      const html = katex.renderToString(trimmed, KATEX_OPTIONS)
      if (html.includes('katex-error') || html.includes(KATEX_ERROR_SENTINEL)) {
        return null
      }
      return html
    } catch {
      return null
    }
  }, [correctionLatex])

  if (renderedHtml !== null) {
    return (
      <span
        className={`inline-block max-w-full overflow-x-auto align-middle text-emerald-200 ${className}`}
        aria-label={correctionText}
        // KaTeX HTML output is generated strictly with trust: false and bounded expansion.
        dangerouslySetInnerHTML={{ __html: renderedHtml }}
      />
    )
  }

  return (
    <span className={`font-medium text-emerald-200 break-words ${className}`}>
      {correctionText}
    </span>
  )
}
