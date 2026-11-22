/** Shared look for every selectable option card (sources, alert modes, detail, formats). */
export function optionCardClass(selected: boolean): string {
  return `flex flex-col items-start gap-1.5 rounded-lg border px-3 py-2.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
    selected
      ? 'border-accent bg-accent/[0.06]'
      : 'border-line bg-white hover:border-zinc-300 hover:bg-zinc-50'
  }`
}
