import { useMemo, useState } from 'react'
import { useLocalRequestFocus } from '../../components/useLocalRequestFocus'
import { safeMediaUrl } from '../../lib/media'
import { DISPLAY_LONGEST, THUMB_LONGEST, fittedSize, mediaSources } from '../recognition/media-variants'
import type { MediaSize } from '../recognition/media-variants'

function Media({ sources, href, alt, thumbnail, size }: { sources: string[]; href: string; alt: string; thumbnail: boolean; size?: MediaSize }) {
  // The compressed copy first; the full file when the copy cannot be loaded; past the last one the fallback.
  const [index, setIndex] = useState(0)
  const failed = index >= sources.length
  const phase = useMemo(() => ({ kind: failed ? 'error' as const : 'ok' as const }), [failed])
  const block = useLocalRequestFocus<HTMLDivElement>(phase)
  return <div ref={block} data-request-focus-target tabIndex={-1} className={`receipt-media${thumbnail ? ' receipt-thumbnail' : ''}`}>
    {failed ? <ReceiptImageFallback alt={alt} retry={() => setIndex(0)} /> : <>
      <a href={href} target="_blank" rel="noreferrer" aria-label={`${alt} — открыть изображение в новой вкладке`}>
        <img src={sources[index]} alt={alt} loading="lazy" decoding="async" width={size?.width} height={size?.height} onError={() => setIndex(index + 1)} />
      </a>
      {!thumbnail && <p className="receipt-note">Открыть изображение в новой вкладке</p>}
    </>}
  </div>
}

export function ReceiptImageFallback({ alt, retry }: { alt: string; retry: () => void }) {
  return <div className="receipt-image-fallback" role="status">
    <p>{alt}: изображение не загрузилось.</p>
    <button type="button" data-request-retry onClick={retry}>Повторить загрузку изображения</button>
  </div>
}

/** `url` — the full image, opened by the link; `display` — its compressed copy (`thumb_url` in a list, `display_url` on the page). */
export default function ReceiptMedia({ url, display, size, alt, thumbnail = false }: {
  url: string | null; display?: string | null; size?: MediaSize; alt: string; thumbnail?: boolean
}) {
  const sources = mediaSources(display, url)
  const href = safeMediaUrl(url) ?? sources[0]
  return href ? <Media key={sources.join(' ')} sources={sources} href={href} alt={alt} thumbnail={thumbnail}
    size={fittedSize(size, !display ? Infinity : thumbnail ? THUMB_LONGEST : DISPLAY_LONGEST)} />
    : <div className={`receipt-media receipt-image-fallback${thumbnail ? ' receipt-thumbnail' : ''}`}>Изображение отсутствует</div>
}
