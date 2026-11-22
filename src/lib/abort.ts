/** True for the DOMException thrown by fetch/media APIs when an AbortSignal fires. */
export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}
