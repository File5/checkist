import type { RecognitionLimits } from '../../api/recognition'

/** Long side of a reduced photo: 4096 × 3072 is 12.6 Mp, below the canvas limit of Safari. */
export const REDUCED_LONG_SIDE = 4096
export const REDUCED_TYPE = 'image/jpeg'
export const REDUCED_QUALITY = 0.9

export type ImageSize = { width: number; height: number }
type Limits = Pick<RecognitionLimits, 'max_bytes' | 'max_pixels'>
/** `keep` — the photo goes as it is; `reduce` — it is drawn again at this size. Without a size only the bytes decide. */
export type ReductionPlan = { kind: 'keep' } | ({ kind: 'reduce'; bytes: boolean; pixels: boolean } & Partial<ImageSize>)

const known = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value > 0

/** The photo is touched only when it does not pass a server limit: the limits themselves still pass. */
export function reductionPlan({ width, height, bytes }: Partial<ImageSize> & { bytes: number }, limits: Limits): ReductionPlan {
  const sized = known(width) && known(height)
  const overBytes = bytes > limits.max_bytes
  const overPixels = sized && width * height > limits.max_pixels
  if (!overBytes && !overPixels) return { kind: 'keep' }
  if (!sized) return { kind: 'reduce', bytes: overBytes, pixels: false }
  return { kind: 'reduce', bytes: overBytes, pixels: overPixels, ...reducedSize({ width, height }, limits) }
}

/** Size of the reduced copy: never enlarged, the long side within 4096 px, the area within the limit of the server. */
export function reducedSize({ width, height }: ImageSize, limits: Pick<Limits, 'max_pixels'>): ImageSize {
  const scale = Math.min(1, REDUCED_LONG_SIDE / Math.max(width, height), Math.sqrt(limits.max_pixels / (width * height)))
  const side = (value: number) => Math.max(1, Math.floor(value * scale + 1e-9))
  return { width: side(width), height: side(height) }
}

export type Reduced = { file: File } & ImageSize
type Decoded = ImageSize & { source: unknown; close(): void }
/** The browser part: decoding with the EXIF turn applied and encoding of a drawn copy. */
export type ReduceEnvironment = {
  decode(file: File): Promise<Decoded>
  encode(source: unknown, size: ImageSize): Promise<Blob | null>
}

export const browserReduce: ReduceEnvironment = {
  async decode(file) {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    return { width: bitmap.width, height: bitmap.height, source: bitmap, close: () => bitmap.close() }
  },
  encode(source, { width, height }) {
    const canvas = document.createElement('canvas')
    canvas.width = width; canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) return Promise.resolve(null)
    context.drawImage(source as ImageBitmap, 0, 0, width, height)
    return new Promise((resolve) => canvas.toBlob((blob) => {
      // Releases the pixels at once: a phone keeps few canvases alive.
      canvas.width = 0; canvas.height = 0
      resolve(blob)
    }, REDUCED_TYPE, REDUCED_QUALITY))
  },
}

export function reducedName(name: string) {
  const dot = name.lastIndexOf('.')
  return `${dot > 0 ? name.slice(0, dot) : name || 'photo'}.jpg`
}

/** One reduced JPEG of the photo. Rejects when the browser cannot decode, draw or encode it, or the result still
 * does not pass the limits; the caller keeps the result and never encodes the same photo twice.
 */
export async function reduceImage(file: File, limits: Limits, signal?: AbortSignal, environment: ReduceEnvironment = browserReduce): Promise<Reduced> {
  const decoded = await environment.decode(file)
  let blob: Blob | null
  let size: ImageSize
  try {
    if (signal?.aborted) throw new Error('aborted')
    // The real size of the decoded photo decides, not the one the screen has read from the preview.
    size = reducedSize(decoded, limits)
    blob = await environment.encode(decoded.source, size)
  } finally {
    decoded.close()
  }
  if (signal?.aborted) throw new Error('aborted')
  if (!blob || blob.size === 0 || blob.type !== REDUCED_TYPE) throw new Error('encode')
  if (blob.size > limits.max_bytes) throw new Error('too_large')
  return { file: new File([blob], reducedName(file.name), { type: REDUCED_TYPE, lastModified: file.lastModified }), ...size }
}
