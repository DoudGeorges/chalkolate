import { NotesDocument } from './notes'

const NUL = String.fromCharCode(0)
const BACKSLASH_MARK = String.fromCharCode(1)

const MATH_COMMANDS = new Set(
  (
    'frac dfrac tfrac sqrt sum prod int iint iiint oint lim log ln exp sin cos tan cot sec csc ' +
    'arcsin arccos arctan sinh cosh tanh min max det gcd mod bmod pmod operatorname ' +
    'left right middle big Big bigg Bigg bigl bigr Bigl Bigr biggl biggr Biggl Biggr ' +
    'cdot times div pm mp ast star circ bullet equiv approx sim simeq cong propto neq ne le leq ' +
    'ge geq ll gg in notin subset subseteq supset supseteq cup cap emptyset setminus forall exists ' +
    'land lor neg implies iff to mapsto gets rightarrow leftarrow leftrightarrow Rightarrow ' +
    'Leftarrow Leftrightarrow longrightarrow Longrightarrow uparrow downarrow ' +
    'infty partial nabla ell hbar Re Im angle perp parallel vert Vert mid lvert rvert lVert rVert ' +
    'langle rangle lceil rceil lfloor rfloor cdots ldots vdots ddots dots prime ' +
    'overline underline underbrace overbrace hat widehat bar vec dot ddot tilde widetilde ' +
    'text textrm textbf textit mathrm mathbf mathit mathsf mathtt mathbb mathcal mathfrak ' +
    'displaystyle textstyle scriptstyle scriptscriptstyle quad qquad enspace binom dbinom tbinom ' +
    'alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi ' +
    'pi varpi rho varrho sigma varsigma tau upsilon phi varphi chi psi omega ' +
    'Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega'
  ).split(' '),
)
const MATH_ENVIRONMENTS = new Set([
  'matrix', 'pmatrix', 'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix', 'smallmatrix', 'aligned', 'cases',
])

function safeMath(tex: string): boolean {
  // TeX commands are executable. Only allow the math constructs supported by this export.
  if (tex.includes('^^') || /[^\x20-\x7e\n\t]|[#$]/.test(tex)) return false
  const groups: string[] = []
  const commandsAndBraces = /\\(begin|end)\{([A-Za-z]+)\}|\\([A-Za-z]+|[^\n])|[\\{}%~]/g
  for (const token of tex.matchAll(commandsAndBraces)) {
    const [value, environmentCommand, environment, command] = token
    if (environmentCommand && environment && MATH_ENVIRONMENTS.has(environment)) {
      if (environmentCommand === 'begin') groups.push(environment)
      else if (groups.pop() !== environment) return false
    } else if (command && (MATH_COMMANDS.has(command) || /^[\\{},;:!|_%& ]$/.test(command))) {
      continue
    } else if (value === '{') {
      groups.push('{')
    } else if (value !== '}' || groups.pop() !== '{') {
      return false
    }
  }
  return groups.length === 0
}

function escapeLatex(text: string): string {
  return text
    .split(BACKSLASH_MARK).join('')
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
 * Standalone LaTeX article. Unsupported math is included as literal text.
 */
export function exportLatex(doc: NotesDocument, now: Date = new Date()): string {
  const math: string[] = []
  const stash = (tex: string, display: boolean) => {
    const formula = tex.trim()
    const rendered = !safeMath(formula)
      ? '\\texttt{' + escapeLatex(formula) + '}'
      : display ? '\\[' + formula + '\\]' : '$' + formula + '$'
    return NUL + (math.push(rendered) - 1) + NUL
  }
  const restore = new RegExp(`${NUL}(\\d+)${NUL}`, 'g')

  const body = doc.sections
    .map((s) => {
      const withMath = s.body_markdown.split(NUL).join('')
        .replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex: string) => stash(tex, true))
        .replace(/(?<![\\$])\$([^$\n]+?)\$(?!\$)/g, (_m, tex: string) => stash(tex, false))
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
      return `\\section*{${latexInline(s.heading.split(NUL).join(''))}}\n\n${blocks.join('\n\n')}`
    })
    .join('\n\n')
    .replace(restore, (_m, i: string) => math[Number(i)] ?? '')

  const title = latexInline(doc.title.split(NUL).join('').trim() || 'Lecture notes')
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
