import { ApiError } from './errors'

export interface ImageInfo {
  mimeType: 'image/jpeg' | 'image/png'
  width: number
  height: number
}

const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
])

function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  let i = 2
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null
    while (b[i] === 0xff) i++
    const marker = b[i]
    i++
    if (marker === undefined) return null
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue
    const len = ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0)
    if (len < 2) return null
    if (SOF_MARKERS.has(marker)) {
      const height = ((b[i + 3] ?? 0) << 8) | (b[i + 4] ?? 0)
      const width = ((b[i + 5] ?? 0) << 8) | (b[i + 6] ?? 0)
      return { width, height }
    }
    if (marker === 0xda) return null // start of scan reached without a frame header
    i += len
  }
  return null
}

function pngSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 24) return null
  const u32 = (o: number) =>
    (((b[o] ?? 0) << 24) | ((b[o + 1] ?? 0) << 16) | ((b[o + 2] ?? 0) << 8) | (b[o + 3] ?? 0)) >>> 0
  return { width: u32(16), height: u32(20) }
}

/** Detect format and dimensions from the header only (no pixel decode). JPEG and PNG are supported. */
export function inspectImage(bytes: Uint8Array, maxPixels: number): ImageInfo {
  if (bytes.length === 0) throw new ApiError(422, 'EMPTY_IMAGE', 'Uploaded image is empty.')

  let mimeType: ImageInfo['mimeType']
  let size: { width: number; height: number } | null
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    mimeType = 'image/jpeg'
    size = jpegSize(bytes)
  } else if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    mimeType = 'image/png'
    size = pngSize(bytes)
  } else {
    throw new ApiError(
      415,
      'UNSUPPORTED_IMAGE_FORMAT',
      'Unsupported image format. Allowed: JPEG, PNG.',
    )
  }

  if (!size || size.width <= 0 || size.height <= 0) {
    throw new ApiError(422, 'CORRUPT_IMAGE', 'Uploaded image appears corrupt or truncated.')
  }
  if (size.width * size.height > maxPixels) {
    throw new ApiError(
      413,
      'IMAGE_PIXELS_EXCEEDED',
      `Image pixel count (${size.width * size.height}) exceeds limit (${maxPixels}).`,
    )
  }
  return { mimeType, ...size }
}
