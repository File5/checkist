import { safeMediaUrl } from '../../lib/media'

/** Pixel size the browser reserves before the file arrives: no layout shift. */
export type MediaSize = { width: number; height: number }
/** Longest side of the server's copies: `display_url` and `thumb_url`. */
export const DISPLAY_LONGEST = 1600
export const THUMB_LONGEST = 400
/** The size of a copy whose longest side is at most `longest`: a copy is never enlarged. */
export function fittedSize(size: MediaSize | undefined, longest: number): MediaSize | undefined {
  if (!size || size.width <= 0 || size.height <= 0) return undefined
  const scale = Math.min(1, longest / Math.max(size.width, size.height))
  return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) }
}
/** Safe distinct sources in order: the compressed copy first, the full file when the copy cannot be loaded. */
export function mediaSources(...urls: (string | null | undefined)[]): string[] {
  return [...new Set(urls.map(safeMediaUrl).filter((url): url is string => url !== null))]
}
/** A PDF upload downloads its PDF: the server names it in `download_url`. */
export function isPdfDownload(url: string) { return /\.pdf\?download=1$/i.test(url) }
