import { useState } from 'react'
import { safeDownloadUrl } from '../../lib/media'
import { DISPLAY_LONGEST, fittedSize, isPdfDownload, mediaSources } from './media-variants'
import type { MediaSize } from './media-variants'
import './MediaImage.css'

/** «Скачать оригинал»: the file the person sent (the PDF of a PDF bill), as an attachment. Nothing for an unsafe or missing URL. */
export function DownloadOriginal({ url }: { url: string | null | undefined }) {
  const href = safeDownloadUrl(url)
  if (!href) return null
  return <a className="action-link ck-media-download" href={href} download>Скачать оригинал{isPdfDownload(href) ? ' (PDF)' : ''}</a>
}

function Image({ sources, alt, size }: { sources: string[]; alt: string; size?: MediaSize }) {
  // The next source after each failed one; past the last only the link to the full file stays.
  const [index, setIndex] = useState(0)
  const src = sources[index]
  return src === undefined
    ? <p className="ck-rec-image-placeholder" role="status">Не удалось загрузить изображение. Остальные данные доступны. <a href={sources[sources.length - 1]} target="_blank" rel="noreferrer">Открыть изображение отдельно</a></p>
    : <img src={src} alt={alt} loading="lazy" decoding="async" width={size?.width} height={size?.height} onError={() => setIndex(index + 1)} />
}

/** `display` — the compressed WebP (`display_url`), `url` — the full image; the full one is loaded only when the copy fails. */
export default function MediaImage({ url, display, alt, size }: { url: string | null; display?: string | null; alt: string; size?: MediaSize }) {
  const sources = mediaSources(display, url)
  return <div className="ck-rec-image">{sources.length
    ? <Image key={sources.join(' ')} sources={sources} alt={alt} size={fittedSize(size, display ? DISPLAY_LONGEST : Infinity)} />
    : <p className="ck-rec-image-placeholder">Изображение пока недоступно.</p>}</div>
}
