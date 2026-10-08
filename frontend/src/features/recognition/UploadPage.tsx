import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { FormEvent } from 'react'
import { getRecognitionCsrf, uploadPhoto } from '../../api/recognition'
import RequestState from '../../components/RequestState'
import { useLocalRequestFocus } from '../../components/useLocalRequestFocus'
import { glue } from '../../lib/text'
import { Link, navigate } from '../../navigation'
import { errorText, isExecutorAbsent, uploadExecutorNote } from './labels'
import { createUpload, fileFormat, formatBytes, setJobNotice, uploadMessage, validateFile } from './upload-state'
import { useRequest } from './useRequest'
import { createPreview } from './preview'

function FilePreview({ file }: { file: File }) {
  const preview = useMemo(() => createPreview(file), [file])
  const url = useSyncExternalStore(preview.subscribe, preview.getSnapshot, preview.getServerSnapshot)
  useEffect(() => { preview.start(); return preview.dispose }, [preview])
  return <div className="ck-rec-image">{url ? <PreviewImage key={url} url={url} name={file.name} /> : <p>Готовим предпросмотр…</p>}</div>
}
function PreviewImage({ url, name }: { url: string; name: string }) {
  const [failed, setFailed] = useState(false)
  return failed
    ? <p className="ck-rec-image-placeholder">Не удалось показать предпросмотр. Изображение может быть повреждено; окончательную проверку выполняет сервер.</p>
    : <img src={url} alt={`Предпросмотр выбранного фото: ${name}`} onError={() => setFailed(true)} />
}

export default function UploadPage() {
  const load = useCallback((signal: AbortSignal) => getRecognitionCsrf({ signal }), [])
  // Absent is polled so the warning disappears once the worker starts; any other state stops the polling.
  const { state: config, request } = useRequest(load, isExecutorAbsent)
  const [file, setFile] = useState<File>()
  const upload = useMemo(() => createUpload(
    (selected, signal) => uploadPhoto(selected, { signal }),
    (signal) => getRecognitionCsrf({ signal }),
    (result) => { setJobNotice(result.job.id, uploadMessage(result)); navigate({ kind: 'job', jobId: result.job.id }) },
    request.setData,
  ), [request])
  const state = useSyncExternalStore(upload.subscribe, upload.getSnapshot, upload.getServerSnapshot)
  useEffect(() => upload.dispose, [upload])
  // Only an explicit refresh disables the buttons; background polling must not make them flicker.
  const [manualRefresh, setManualRefresh] = useState(false)
  const refreshConfig = useCallback(() => {
    setManualRefresh(true)
    const unsubscribe = request.subscribe(() => {
      const next = request.getSnapshot()
      if (next.kind === 'ok' && next.refreshing) return
      unsubscribe(); setManualRefresh(false)
    })
    request.refresh()
  }, [request])
  const configBlock = useLocalRequestFocus(config)
  const formBlock = useLocalRequestFocus<HTMLFormElement>({ kind: state.kind === 'sending' ? 'loading' : state.kind === 'error' ? 'error' : 'ok' })
  const limits = config.kind === 'ok' ? config.data.limits : undefined
  // A failed refresh leaves a stale snapshot: say nothing about the worker until the next answer.
  const executorNote = config.kind === 'ok' && !config.refreshError ? uploadExecutorNote(config.data.executor.state) : undefined
  const invalid = file ? validateFile(file, limits) : undefined
  const sending = state.kind === 'sending'
  const refreshing = manualRefresh && config.kind === 'ok' && config.refreshing
  // Like job actions, the upload pauses background reads before touching the server.
  useEffect(() => { if (!sending) return; request.pause(); return () => request.resume(false) }, [sending, request])
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (file && limits) void upload.submit(file, limits)
  }
  return <div className="ck-rec">
    <div className="ck-rec-actions"><Link to="/recognition/jobs" className="action-link">К обработке</Link><Link to="/receipts" className="action-link">К чекам</Link></div>
    <section ref={configBlock} className="ck-rec-panel" aria-labelledby="recognition-limits-title" aria-busy={config.kind === 'loading'}>
      <h2 id="recognition-limits-title" tabIndex={-1} data-request-focus-target>Условия загрузки</h2>
      {config.kind === 'loading' && <RequestState kind="loading" message="Получаем лимиты и токен безопасности…" />}
      {config.kind === 'error' && <RequestState kind="error" message={errorText(config.error)} onRetry={request.refresh} />}
      {config.kind === 'ok' && <>
        <p>Форматы: {config.data.limits.formats.map((format) => format.replace('image/', '').toUpperCase()).join(', ')}. Максимальный размер: {formatBytes(config.data.limits.max_bytes)}. До {glue(config.data.limits.max_pixels.toLocaleString('ru-RU'), 'пикселей')} и {glue(config.data.limits.max_receipts.toLocaleString('ru-RU'), 'чеков')} на фото.</p>
        {executorNote && <p className={executorNote.warning ? 'ck-rec-warning' : undefined}>{executorNote.text}</p>}
        <button type="button" disabled={sending || refreshing} onClick={refreshConfig}>Обновить условия загрузки</button>
        {config.refreshError && <p role="status" className="ck-rec-error">Не удалось обновить условия. {errorText(config.refreshError)}</p>}
      </>}
    </section>
    <form ref={formBlock} onSubmit={submit} className="ck-rec-panel" aria-labelledby="recognition-file-title" aria-busy={sending}>
      <h2 id="recognition-file-title" tabIndex={-1} data-request-focus-target>Одно фото с одним или несколькими чеками</h2>
      <label htmlFor="recognition-file">Выберите фото</label>
      <input id="recognition-file" type="file" accept=".jpg,.jpeg,.png,.webp" disabled={sending} aria-describedby={`recognition-cloud-warning${invalid ? ' recognition-file-error' : ''}`} aria-invalid={Boolean(invalid)} onChange={(event) => { upload.reset(); setFile(event.target.files?.[0]) }} />
      {file && <><p>{file.name} · {fileFormat(file)?.replace('image/', '').toUpperCase() ?? 'Неподдерживаемый формат'} · {formatBytes(file.size)}</p>{!invalid && <FilePreview key={`${file.name}:${file.lastModified}:${file.size}`} file={file} />}</>}
      {invalid && <p id="recognition-file-error" role="status" className="ck-rec-error">{invalid}</p>}
      <p id="recognition-cloud-warning" className="ck-rec-warning">Фото передаётся облачной модели распознавания. Отправляйте только фото, которое вы готовы передать сервису.</p>
      <button type="submit" data-request-retry={state.kind === 'error' ? '' : undefined} disabled={!file || !limits || Boolean(invalid) || sending || refreshing}>{sending ? 'Отправляем фото…' : state.kind === 'error' ? 'Повторить загрузку' : 'Загрузить фото'}</button>
      <div role="status" aria-live="polite">{sending && <p>Отправляем файл. Дождитесь ответа сервера; распознавание начнётся отдельно.</p>}{state.kind === 'error' && <p className="ck-rec-error">{state.message}</p>}{state.kind === 'success' && <p>{state.message}</p>}</div>
      {state.kind === 'error' && <Link to="/recognition/jobs">Проверить список обработки</Link>}
    </form>
  </div>
}
