import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import { getRecognitionCsrf, uploadPhoto } from '../../api/recognition'
import RequestState from '../../components/RequestState'
import { useLocalRequestFocus } from '../../components/useLocalRequestFocus'
import { glue } from '../../lib/text'
import { Link, navigate } from '../../navigation'
import { reduceImage, reductionPlan } from './image-reduce'
import type { ImageSize } from './image-reduce'
import { errorText, isExecutorAbsent, sizeText, uploadExecutorNote, uploadLabels } from './labels'
import { createUpload, fileFormat, formatBytes, progressValue, setJobNotice, uploadMessage, validateFormat } from './upload-state'
import { useRequest } from './useRequest'
import { createPreview } from './preview'
import './Upload.css'

/** `null` — the browser could not show the photo, so its pixel size stays unknown. */
type Measured = ImageSize | null
function FilePreview({ file, onMeasure }: { file: File; onMeasure: (size: Measured) => void }) {
  const preview = useMemo(() => createPreview(file), [file])
  const url = useSyncExternalStore(preview.subscribe, preview.getSnapshot, preview.getServerSnapshot)
  useEffect(() => { preview.start(); return preview.dispose }, [preview])
  return <div className="ck-rec-image">{url ? <PreviewImage key={url} url={url} name={file.name} onMeasure={onMeasure} /> : <p>Готовим предпросмотр…</p>}</div>
}
function PreviewImage({ url, name, onMeasure }: { url: string; name: string; onMeasure: (size: Measured) => void }) {
  const [failed, setFailed] = useState(false)
  return failed
    ? <p className="ck-rec-image-placeholder">Не удалось показать предпросмотр. Изображение может быть повреждено; окончательную проверку выполняет сервер.</p>
    : <img src={url} alt={`Предпросмотр выбранного фото: ${name}`}
        onLoad={(event) => onMeasure({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        onError={() => { setFailed(true); onMeasure(null) }} />
}
/** A number with its unit or «N × M»: never split. */
const Value = ({ children }: { children: string }) => <span className="ck-upload-value">{children}</span>
/** Bytes of the file that left the browser. Not a live region: only a change of the stage is announced. */
export function UploadProgress({ sent, total }: { sent: number; total: number }) {
  return <div className="ck-upload-progress">
    <progress aria-label={uploadLabels.progress} max={total} value={Math.min(sent, total)} />
    <p>Отправлено <Value>{progressValue(sent, total)}</Value></p>
  </div>
}

export default function UploadPage() {
  const load = useCallback((signal: AbortSignal) => getRecognitionCsrf({ signal }), [])
  // Absent is polled so the warning disappears once the worker starts; any other state stops the polling.
  const { state: config, request } = useRequest(load, isExecutorAbsent)
  const [file, setFile] = useState<File>()
  // Pixel size of the chosen photo, read from its preview; undefined until the preview has loaded or failed.
  const [measured, setMeasured] = useState<Measured>()
  const fileInput = useRef<HTMLInputElement>(null)
  const cameraInput = useRef<HTMLInputElement>(null)
  const upload = useMemo(() => createUpload(
    (selected, signal, onProgress) => uploadPhoto(selected, { signal, onProgress }),
    (signal) => getRecognitionCsrf({ signal }),
    (result) => { setJobNotice(result.job.id, uploadMessage(result)); navigate({ kind: 'job', jobId: result.job.id }) },
    request.setData,
    reduceImage,
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
  // A photo over a limit is not refused here: it is reduced before sending.
  const invalid = file ? validateFormat(file, limits) : undefined
  const sending = state.kind === 'sending'
  const reducing = sending && state.stage === 'reducing'
  const measuring = Boolean(file) && !invalid && measured === undefined
  const plan = file && limits && !invalid && !measuring ? reductionPlan({ ...measured, bytes: file.size }, limits) : undefined
  const outgoing = state.reduced?.file ?? file
  const repeat = state.kind === 'error' || state.kind === 'cancelled'
  const refreshing = manualRefresh && config.kind === 'ok' && config.refreshing
  // Like job actions, the upload pauses background reads before touching the server.
  useEffect(() => { if (!sending) return; request.pause(); return () => request.resume(false) }, [sending, request])
  // A closed picker or camera returns no file: the photo already chosen stays.
  const pick = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.target.files?.[0]
    event.target.value = ''
    if (!next) return
    upload.reset(); setMeasured(undefined); setFile(next)
  }
  // Without the conditions nothing can be checked or sent.
  const pickDisabled = !limits || sending
  const described = `recognition-cloud-warning${invalid ? ' recognition-file-error' : ''}${limits ? '' : ' recognition-pick-wait'}`
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (file && limits && !measuring) void upload.submit(file, limits, measured ?? undefined)
  }
  return <div className="ck-rec">
    <div className="ck-rec-actions"><Link to="/recognition/jobs" className="action-link">К обработке</Link><Link to="/receipts" className="action-link">К чекам</Link></div>
    <form ref={formBlock} onSubmit={submit} className="ck-rec-panel" aria-labelledby="recognition-file-title" aria-busy={sending}>
      <h2 id="recognition-file-title" tabIndex={-1} data-request-focus-target>Одно фото с одним или несколькими чеками</h2>
      <div className="ck-rec-actions ck-upload-pick" role="group" aria-label="Выбор фото">
        <button type="button" className="ck-upload-camera" disabled={pickDisabled} aria-describedby={described} onClick={() => cameraInput.current?.click()}>{uploadLabels.camera}</button>
        <button type="button" className="ck-upload-secondary" disabled={pickDisabled} aria-describedby={described} onClick={() => fileInput.current?.click()}>{uploadLabels.pick}</button>
        <input ref={cameraInput} id="recognition-camera" className="ck-upload-input" type="file" accept="image/*" capture="environment" tabIndex={-1} aria-hidden="true" disabled={pickDisabled} onChange={pick} />
        <input ref={fileInput} id="recognition-file" className="ck-upload-input" type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" tabIndex={-1} aria-hidden="true" disabled={pickDisabled} onChange={pick} />
      </div>
      {!limits && <p id="recognition-pick-wait" className="ck-rec-note">{config.kind === 'error' ? uploadLabels.conditionsFailed : uploadLabels.conditionsLoading}</p>}
      {file && <><p className="ck-upload-file">{file.name} · {fileFormat(file)?.replace('image/', '').toUpperCase() ?? 'Неподдерживаемый формат'} · {formatBytes(file.size)}{measured && <> · <Value>{sizeText(measured)}</Value></>}</p>{!invalid && <FilePreview key={`${file.name}:${file.lastModified}:${file.size}`} file={file} onMeasure={setMeasured} />}</>}
      {invalid && <p id="recognition-file-error" role="status" className="ck-rec-error">{invalid}</p>}
      {state.reduced
        ? <p className="ck-upload-reduced">Фото больше лимита сервера, перед отправкой уменьшено до <Value>{sizeText(state.reduced)}</Value>. Отправляется уменьшенная копия: {formatBytes(state.reduced.file.size)}.</p>
        : plan?.kind === 'reduce' && <p className="ck-upload-reduced">Фото больше лимита сервера: перед отправкой оно будет уменьшено{plan.width && plan.height ? <> до <Value>{sizeText({ width: plan.width, height: plan.height })}</Value></> : null}.</p>}
      <p id="recognition-cloud-warning" className="ck-rec-warning">Фото передаётся облачной модели распознавания. Отправляйте только фото, которое вы готовы передать сервису.</p>
      {sending && !reducing && outgoing && <UploadProgress sent={state.sent ?? 0} total={state.total ?? outgoing.size} />}
      <div className="ck-rec-actions ck-action-bar">
        <button type="submit" data-request-retry={repeat ? '' : undefined} disabled={!file || !limits || Boolean(invalid) || measuring || sending || refreshing}>{reducing ? uploadLabels.reducing : sending ? uploadLabels.sending : repeat ? uploadLabels.retry : uploadLabels.submit}</button>
        {sending && <button type="button" className="ck-upload-secondary" onClick={upload.cancel}>{uploadLabels.cancel}</button>}
      </div>
      {/* Only the change of a stage is announced: the bytes of the progress above are outside the live region. */}
      <div role="status" aria-live="polite">{sending && <p>{state.stage === 'reducing' ? uploadLabels.stageReducing : state.stage === 'waiting' ? uploadLabels.stageWaiting : uploadLabels.stageUploading}</p>}{state.kind === 'cancelled' && <p>{state.message}</p>}{state.kind === 'error' && <p className="ck-rec-error">{state.message}</p>}{state.kind === 'success' && <p>{state.message}</p>}</div>
      {(state.kind === 'error' || (state.kind === 'cancelled' && state.message === uploadLabels.cancelled)) && <Link to="/recognition/jobs">Проверить список обработки</Link>}
    </form>
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
  </div>
}
