import { useEffect, useState } from 'react'
import { getPhoto } from '../../api/recognition'
import { mediaSources } from './media-variants'

/** The miniature of the photo of a job row. A job carries no picture of its own, so the row reads its photo once
 * (`thumb_url`, the 400 px copy), without polling; until then, and when the read fails, a quiet empty frame stays.
 * Decorative: the link of the row names the job and its photo. */
export default function JobThumb({ photoId }: { photoId: number }) {
  const [sources, setSources] = useState<string[]>([])
  const [index, setIndex] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    void getPhoto(photoId, { signal: controller.signal }).then((result) => {
      if (result.kind === 'ok') { setIndex(0); setSources(mediaSources(result.data.thumb_url, result.data.display_url)) }
    }, () => undefined)
    return () => controller.abort()
  }, [photoId])
  const src = sources[index]
  return <div className="ck-rec-thumb" aria-hidden="true">
    {src !== undefined && <img src={src} alt="" loading="lazy" decoding="async" onError={() => setIndex(index + 1)} />}
  </div>
}
