import { NotesDocument } from './notes'

const NUL = String.fromCharCode(0)
const BACKSLASH_MARK = String.fromCharCode(1)

function escapeLatex(text: string): string {
  return text
    .replace(/\\/g, BACKSLASH_MARK)
    .replace(/([{}#%&_$])/g, '\\$1')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/~/g, '\\textasciitilde{}')
    .split(BACKSLASH_MARK)
    .join('\\textbackslash{}')
}

function latexInline(text: string): string {
  return escapeLatex(text)
    .replace(/`([^`\n]+)`/g, '\\texttt{$1}')
    .replace(/\*\*([^*\n]+)\*\*/g, '\\textbf{$1}')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1\\emph{$2}')
}

/**
 * Standalone LaTeX article (compiles with pdflatex/Overleaf). Math passes through unchanged;
 * surrounding text is escaped. Board figures are not embedded (no external files), so each is
 * replaced by a short note pointing to the Markdown/PDF export.
 */
export function exportLatex(doc: NotesDocument, now: Date = new Date()): string {
  const math: string[] = []
  const stash = (tex: string) => `${NUL}${math.push(tex) - 1}${NUL}`
  const restore = new RegExp(`${NUL}(\\d+)${NUL}`, 'g')

  const body = doc.sections
    .map((s) => {
      const withMath = s.body_markdown
        .replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex: string) => stash(`\\[${tex.trim()}\\]`))
        .replace(/(?<![\\$])\$([^$\n]+?)\$(?!\$)/g, (_m, tex: string) => stash(`$${tex.trim()}$`))
      const blocks = withMath
        .split(/\n{2,}/)
        .map((block) => {
          const lines = block.split('\n').filter((l) => l.trim().length > 0)
          if (lines.length === 0) return ''
          if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) {
            const items = lines.map((l) => `  \\item ${latexInline(l.replace(/^\s*[-*•]\s+/, ''))}`)
            return `\\begin{itemize}\n${items.join('\n')}\n\\end{itemize}`
          }
          if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
            const items = lines.map((l) => `  \\item ${latexInline(l.replace(/^\s*\d+[.)]\s+/, ''))}`)
            return `\\begin{enumerate}\n${items.join('\n')}\n\\end{enumerate}`
          }
          return latexInline(lines.join('\n'))
        })
        .filter((b) => b.length > 0)
      if (s.figure) {
        blocks.push('\\textit{[Board figure omitted; see the Markdown or PDF export.]}')
      }
      return `\\section*{${latexInline(s.heading)}}\n\n${blocks.join('\n\n')}`
    })
    .join('\n\n')
    .replace(restore, (_m, i: string) => math[Number(i)] ?? '')

  const title = latexInline(doc.title.trim() || 'Lecture notes')
  return `\\documentclass[11pt]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath,amssymb}
\\usepackage[margin=1in]{geometry}
\\title{${title}}
\\date{${now.toISOString().slice(0, 10)}}
\\begin{document}
\\maketitle

${body}

\\end{document}
`
}
