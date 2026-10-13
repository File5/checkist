import { useState } from 'react'
import type { Job } from '../../api/recognition'
import { mediaSources } from './media-variants'

/** The miniature of the photo of a job row: `thumb_url` of the job (the 400 px copy of its source photo), the
 * 1600 px copy when the small one cannot be loaded, a quiet empty frame past both. No request of its own.
 * Decorative: the link of the row names the job and its photo. */
export default function JobThumb({ job }: { job: Pick<Job, 'thumb_url' | 'display_url'> }) {
  const sources = mediaSources(job.thumb_url, job.display_url)
  const [failed, setFailed] = useState(0)
  const src = sources[failed]
  return <div className="ck-rec-thumb" aria-hidden="true">
    {src !== undefined && <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(failed + 1)} />}
  </div>
}
