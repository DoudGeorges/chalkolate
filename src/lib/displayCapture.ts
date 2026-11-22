/**
 * Screen-capture helpers that prevent Chalkolate from capturing its own preview
 * (the app showing the app showing the app...).
 *
 * Layers of defence:
 * 1. Chromium hints (`selfBrowserSurface: 'exclude'`, `preferCurrentTab: false`, ...) remove the
 *    current tab from the picker and steer the user to other surfaces.
 * 2. Browsers without those hints (Firefox, Safari) still show the tab; after capture starts we
 *    compare the track's label with `document.title` (tab and window labels are the page/window
 *    title) and refuse the stream with a clear message.
 * 3. A whole-monitor share cannot be identified as self-capture; it is allowed.
 */

export const SELF_CAPTURE_MESSAGE =
  'Choose the lecture window, tab, or screen to avoid capturing the Chalkolate preview.'

/** `getDisplayMedia` options newer than lib.dom typings; unsupported keys are ignored by browsers. */
export type DisplayMediaOptionsWithHints = DisplayMediaStreamOptions & {
  preferCurrentTab?: boolean
  selfBrowserSurface?: 'include' | 'exclude'
  surfaceSwitching?: 'include' | 'exclude'
  monitorTypeSurfaces?: 'include' | 'exclude'
  systemAudio?: 'include' | 'exclude'
}

export function buildDisplayMediaOptions(): DisplayMediaOptionsWithHints {
  return {
    video: true,
    audio: false,
    preferCurrentTab: false,
    selfBrowserSurface: 'exclude',
    // Switching surfaces mid-share could silently move capture onto this tab.
    surfaceSwitching: 'exclude',
    monitorTypeSurfaces: 'include',
    systemAudio: 'exclude',
  }
}

export type DisplaySurface = 'browser' | 'window' | 'monitor' | undefined

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * True when a capture track appears to show this very page. Tab capture labels equal the page
 * title; window capture labels contain it (e.g. "Chalkolate - Google Chrome"). Monitor captures
 * and missing/short titles are never flagged.
 */
export function isLikelySelfCapture(
  trackLabel: string,
  displaySurface: DisplaySurface,
  documentTitle: string,
): boolean {
  if (displaySurface === 'monitor') return false
  const label = normalize(trackLabel)
  const title = normalize(documentTitle)
  if (!label || title.length < 3) return false
  if (displaySurface === 'browser') return label === title
  return label === title || label.includes(title)
}
