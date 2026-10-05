import { useMemo, useState } from 'react'
import { useLocalRequestFocus } from '../../components/useLocalRequestFocus'
import { safeMediaUrl } from '../../lib/media'

function Media({ src, alt, thumbnail }: { src: string; alt: string; thumbnail: boolean }) {
  const [failed, setFailed] = useState(false)
  const phase = useMemo(() => ({ kind: failed ? 'error' as const : 'ok' as const }), [failed])
  const block = useLocalRequestFocus<HTMLDivElement>(phase)
  return <div ref={block} data-request-focus-target tabIndex={-1} className={`receipt-media${thumbnail ? ' receipt-thumbnail' : ''}`}>
    {failed ? <ReceiptImageFallback alt={alt} retry={() => setFailed(false)} /> : <>
      <a href={src} target="_blank" rel="noreferrer" aria-label={`${alt} — открыть изображение в новой вкладке`}>
        <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} />
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

export default function ReceiptMedia({ url, alt, thumbnail = false }: { url: string | null; alt: string; thumbnail?: boolean }) {
  const src = safeMediaUrl(url)
  return src ? <Media key={src} src={src} alt={alt} thumbnail={thumbnail} />
    : <div className={`receipt-media receipt-image-fallback${thumbnail ? ' receipt-thumbnail' : ''}`}>Изображение отсутствует</div>
}
