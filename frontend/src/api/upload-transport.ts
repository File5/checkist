import type { TransportFailure } from './http.ts'

/** Bytes that left the browser so far and bytes to send. Never called with a smaller `sent` than before. */
export type UploadProgress = (sent: number, total: number) => void

/** No byte left the browser for this long: the upload is stalled, however long it has been running. */
export const UPLOAD_IDLE_MS = 30_000
/** The whole body is sent: the server has this long to answer. */
export const UPLOAD_RESPONSE_MS = 60_000

/** `fetch` cannot report upload progress; Node (the proxy check scripts) has no XMLHttpRequest. */
export function canReportProgress(): boolean {
  return typeof XMLHttpRequest === 'function'
}

/** Progress of a multipart body restated in bytes of the file itself, so that `total` equals the size shown to the person. */
export function fileProgress(size: number, onProgress: UploadProgress): UploadProgress {
  return (sent, total) => onProgress(total > 0 ? Math.min(size, Math.round((sent / total) * size)) : 0, size)
}

export type UploadRequest = {
  signal?: AbortSignal
  headers?: Record<string, string>
  successStatuses?: readonly number[]
  onProgress?: UploadProgress
}

/** One POST of a body through XMLHttpRequest. Same results as `sendJson`, except the deadline: there is no
 * total one — a slow network may take minutes while bytes keep moving. Cookies follow the same-origin default.
 */
export function sendUpload<T, F extends { kind: 'error' } | { kind: 'aborted' }>(
  url: string, body: FormData, validate: (value: unknown) => value is T,
  { signal, headers = {}, successStatuses = [200], onProgress }: UploadRequest,
  refusal: (status: number, body: unknown) => F,
): Promise<{ kind: 'ok'; data: T } | F | TransportFailure | { kind: 'aborted' }> {
  type Result = { kind: 'ok'; data: T } | F | TransportFailure | { kind: 'aborted' }
  return new Promise<Result>((resolve) => {
    if (signal?.aborted) return resolve({ kind: 'aborted' })
    const xhr = new XMLHttpRequest()
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    let bodySent = false
    let moved = -1
    let reported = -1
    const finish = (result: Result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      resolve(result)
    }
    // Settle first: `abort()` fires `onabort` synchronously, and a late answer must not win.
    const stop = (result: Result) => {
      if (settled) return
      finish(result)
      xhr.abort()
    }
    const cancel = () => stop({ kind: 'aborted' })
    const wait = (ms: number) => {
      clearTimeout(timer)
      timer = setTimeout(() => stop({ kind: 'error', reason: 'timeout' }), ms)
    }
    const report = (event: ProgressEvent) => {
      if (!onProgress || !event.lengthComputable || event.loaded <= reported) return
      reported = event.loaded
      try {
        onProgress(event.loaded, event.total)
      } catch {
        // The request result does not depend on the screen.
      }
    }
    xhr.upload.onprogress = (event) => {
      if (settled || bodySent) return
      // Only real movement postpones the deadline: a repeated event with the same count does not.
      if (event.loaded > moved) {
        moved = event.loaded
        wait(UPLOAD_IDLE_MS)
      }
      report(event)
    }
    xhr.upload.onload = (event) => {
      if (settled || bodySent) return
      bodySent = true
      wait(UPLOAD_RESPONSE_MS)
      report(event)
    }
    xhr.onload = () => {
      const status = xhr.status
      let answer: unknown
      try {
        answer = JSON.parse(xhr.responseText)
      } catch {
        return finish({ kind: 'error', reason: 'invalid_response', status })
      }
      if (!successStatuses.includes(status)) return finish(refusal(status, answer))
      try {
        finish(validate(answer) ? { kind: 'ok', data: answer } : { kind: 'error', reason: 'invalid_response', status })
      } catch {
        finish({ kind: 'error', reason: 'invalid_response', status })
      }
    }
    xhr.onerror = () => finish({ kind: 'error', reason: 'network' })
    xhr.onabort = () => finish({ kind: 'aborted' })
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      xhr.open('POST', url)
      for (const [name, value] of Object.entries({ Accept: 'application/json', ...headers })) xhr.setRequestHeader(name, value)
      wait(UPLOAD_IDLE_MS)
      xhr.send(body)
    } catch {
      stop({ kind: 'error', reason: 'network' })
    }
  })
}
