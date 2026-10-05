import { useState } from 'react'
import { safeMediaUrl } from '../../lib/media'

function Image({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false)
  return failed ? <p className="ck-rec-image-placeholder" role="status">Не удалось загрузить изображение. Остальные данные доступны. <a href={src} target="_blank" rel="noreferrer">Открыть изображение отдельно</a></p>
    : <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} />
}
export default function MediaImage({ url, alt }: { url: string | null; alt: string }) {
  const src = safeMediaUrl(url)
  return <div className="ck-rec-image">{src ? <Image key={src} src={src} alt={alt} /> : <p className="ck-rec-image-placeholder">Изображение пока недоступно.</p>}</div>
}
