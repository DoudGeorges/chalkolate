export type MediaFrameSource = HTMLVideoElement | HTMLImageElement | HTMLCanvasElement

export interface GrayscaleSample {
  width: number
  height: number
  data: Uint8Array
}

export function getMediaIntrinsicSize(
  source: MediaFrameSource | null,
): { width: number; height: number } | null {
  if (!source) return null
  if (source instanceof HTMLVideoElement) {
    if (source.readyState < 2 || source.videoWidth <= 0 || source.videoHeight <= 0) {
      return null
    }
    return { width: source.videoWidth, height: source.videoHeight }
  }
  if (source instanceof HTMLImageElement) {
    if (!source.complete || source.naturalWidth <= 0 || source.naturalHeight <= 0) {
      return null
    }
    return { width: source.naturalWidth, height: source.naturalHeight }
  }
  if (source.width <= 0 || source.height <= 0) {
    return null
  }
  return { width: source.width, height: source.height }
}

export function sampleGrayscaleFrame(
  source: MediaFrameSource,
  canvas: HTMLCanvasElement,
  targetLongEdge = 320,
): GrayscaleSample | null {
  const intrinsic = getMediaIntrinsicSize(source)
  if (!intrinsic) return null

  const longEdge = Math.max(intrinsic.width, intrinsic.height)
  const scale = Math.min(1, targetLongEdge / longEdge)
  const width = Math.max(16, Math.round(intrinsic.width * scale))
  const height = Math.max(16, Math.round(intrinsic.height * scale))

  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height

  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null

  ctx.clearRect(0, 0, width, height)
  ctx.drawImage(source, 0, 0, width, height)
  const imageData = ctx.getImageData(0, 0, width, height)
  const rgba = imageData.data
  const luma = new Uint8Array(width * height)

  for (let i = 0, p = 0; i < luma.length; i++, p += 4) {
    const r = rgba[p] ?? 0
    const g = rgba[p + 1] ?? 0
    const b = rgba[p + 2] ?? 0
    luma[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b)
  }

  return { width, height, data: luma }
}

export async function captureJpegBlob(
  source: MediaFrameSource,
  canvas: HTMLCanvasElement,
  maxLongEdge = 1600,
): Promise<{ blob: Blob; width: number; height: number }> {
  const intrinsic = getMediaIntrinsicSize(source)
  if (!intrinsic) {
    throw new Error('Media source does not have a decoded frame ready for capture.')
  }

  const longEdge = Math.max(intrinsic.width, intrinsic.height)
  const scale = Math.min(1, maxLongEdge / longEdge)
  const width = Math.max(1, Math.round(intrinsic.width * scale))
  const height = Math.max(1, Math.round(intrinsic.height * scale))

  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height

  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('Unable to acquire 2D canvas context for frame capture.')
  }

  ctx.clearRect(0, 0, width, height)
  ctx.drawImage(source, 0, 0, width, height)

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((result) => resolve(result), 'image/jpeg', 0.86)
  })

  if (!blob || blob.size === 0) {
    throw new Error('Failed to encode board snapshot as JPEG.')
  }

  return { blob, width, height }
}
