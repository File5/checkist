import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ChangeEvent, FormEvent, ReactNode } from 'react'
import { getRecognitionCsrf, uploadPhoto } from '../../api/recognition'
import RequestState from '../../components/RequestState'
import { useLocalRequestFocus } from '../../components/useLocalRequestFocus'
import { glue } from '../../lib/text'
import { Link, navigate } from '../../navigation'
import { reduceImage, reductionPlan } from './image-reduce'
import type { ImageSize } from './image-reduce'
import { errorText, isExecutorAbsent, sizeText, uploadExecutorNote, uploadLabels } from './labels'
import { autoSendStep, createUpload, fileFormat, formatBytes, formatName, isPdf, pdfPageCount, pdfSummary, pickAccept, progressValue, setJobNotice, uploadMessage, validateFormat } from './upload-state'
import { useRequest } from './useRequest'
import { createPreview } from './preview'
import { clearQuickShot, onQuickShot, peekQuickShot } from './quick-shot'
import { useQuickShot } from './QuickShot'
import { useNarrow } from '../../lib/cards'
import { useStickyOpen } from './mobile-state'
import './Upload.css'

/** `null` — the browser could not show the photo, so its pixel size stays unknown. */
type Measured = ImageSize | null
function FilePreview({ file, onMeasure }: { file: File; onMeasure: (size: Measured) => void }) {
  const preview = useMemo(() => createPreview(file), [file])
  const url = useSyncExternalStore(preview.subscribe, preview.getSnapshot, preview.getServerSnapshot)
  useEffect(() => { preview.start(); return preview.dispose }, [preview])
  return <div className="ck-rec-image ck-upload-preview">{url ? <PreviewImage key={url} url={url} name={file.name} onMeasure={onMeasure} /> : <p>Готовим предпросмотр…</p>}</div>
}
function PreviewImage({ url, name, onMeasure }: { url: string; name: string; onMeasure: (size: Measured) => void }) {
  const [failed, setFailed] = useState(false)
  return failed
    ? <p className="ck-rec-image-placeholder">Не удалось показать предпросмотр. Изображение может быть повреждено; окончательную проверку выполняет сервер.</p>
    : <img src={url} alt={`Предпросмотр выбранного фото: ${name}`}
        onLoad={(event) => onMeasure({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        onError={() => { setFailed(true); onMeasure(null) }} />
}
/** A PDF has no picture here: its pages, read from the file, and what the server will do with them. */
function PdfPreview({ file, maxPages }: { file: File; maxPages?: number }) {
  const [pages, setPages] = useState<number | null | undefined>()
  useEffect(() => {
    let live = true
    file.text().then((text) => { if (live) setPages(pdfPageCount(text)) }, () => { if (live) setPages(null) })
    return () => { live = false }
  }, [file])
  const over = maxPages !== undefined && typeof pages === 'number' && pages > maxPages
  return <div className="ck-rec-image ck-upload-pdf">
    <p><strong>{pages === undefined ? 'PDF' : pdfSummary(pages)}</strong></p>
    <p className="ck-rec-note">Сервер превратит {maxPages ? glue('до', maxPages, 'страниц') : 'страницы'} в одно изображение и распознает его как чек.</p>
    {over && <p className="ck-rec-warning">Похоже, в файле больше {glue(maxPages, 'страниц')}: сервер такой PDF не примет.</p>}
  </div>
}
/** Pictures of the three ways to pick a photo; the words of the buttons name them. */
const icon = (paths: ReactNode) => <svg className="ck-upload-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths}</svg>
const cameraIcon = icon(<><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle cx="12" cy="13" r="4" /></>)
const galleryIcon = icon(<><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="m21 16-5-5-9 9" /></>)
const fileIcon = icon(<><path d="M14 3H6v18h12V7z" /><path d="M14 3v4h4M9 13h6M9 17h6" /></>)
const chevron = <svg className="ck-upload-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
  strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="m9 6 6 6-6 6" /></svg>

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
  // A file from «Снять чек» or «Из галереи» of the «＋» menu (or «Главная») arrives here and is sent like a shot taken on this page.
  const [file, setFile] = useState<File | undefined>(peekQuickShot)
  // Pixel size of the chosen photo, read from its preview; undefined until the preview has loaded or failed.
  const [measured, setMeasured] = useState<Measured>()
  const fileInput = useRef<HTMLInputElement>(null)
  const cameraInput = useRef<HTMLInputElement>(null)
  // «Из галереи» is the one mechanism of the «＋» menu: its file comes back through onQuickShot below and is sent by itself.
  const gallery = useQuickShot('gallery')
  const narrow = useNarrow()
  // The photo just taken with «Снять чек»: it is sent by itself once, as soon as it can be.
  const autoSend = useRef<File | undefined>(file)
  useEffect(clearQuickShot, [])
  const upload = useMemo(() => createUpload(
    (selected, signal, onProgress) => uploadPhoto(selected, { signal, onProgress }),
    (signal) => getRecognitionCsrf({ signal }),
    (result) => { setJobNotice(result.job.id, uploadMessage(result)); navigate({ kind: 'job', jobId: result.job.id }) },
    request.setData,
    reduceImage,
  ), [request])
  const state = useSyncExternalStore(upload.subscribe, upload.getSnapshot, upload.getServerSnapshot)
  useEffect(() => upload.dispose, [upload])
  // «Снять чек» of the «＋» menu while this page is open: the new shot replaces the chosen photo and is sent by itself.
  useEffect(() => onQuickShot((next) => {
    autoSend.current = next
    upload.reset(); setMeasured(undefined); setFile(next)
  }), [upload])
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
  const pdf = Boolean(file && isPdf(file))
  const sending = state.kind === 'sending'
  const reducing = sending && state.stage === 'reducing'
  // A PDF has no pixel size in the browser: nothing to measure, nothing to reduce.
  const measuring = Boolean(file) && !invalid && !pdf && measured === undefined
  const plan = file && limits && !invalid && !measuring && !pdf ? reductionPlan({ ...measured, bytes: file.size }, limits) : undefined
  const outgoing = state.reduced?.file ?? file
  const repeat = state.kind === 'error' || state.kind === 'cancelled'
  const refreshing = manualRefresh && config.kind === 'ok' && config.refreshing
  // Like job actions, the upload pauses background reads before touching the server.
  useEffect(() => { if (!sending) return; request.pause(); return () => request.resume(false) }, [sending, request])
  // A closed picker or camera returns no file: the photo already chosen stays.
  // A shot of the camera is sent by itself, as from the «＋» menu; «Выбрать файл» waits for the button.
  const pick = (event: ChangeEvent<HTMLInputElement>, sendNow: boolean) => {
    const next = event.target.files?.[0]
    event.target.value = ''
    if (!next) return
    autoSend.current = sendNow ? next : undefined
    upload.reset(); setMeasured(undefined); setFile(next)
  }
  // The same path as the button: reduction, progress, cancel and the job page. A failure leaves the retry button.
  useEffect(() => {
    const step = autoSendStep({ file, pending: autoSend.current, limits, invalid, measuring, refreshing, idle: state.kind === 'idle' })
    if (step !== 'send' && step !== 'drop') return
    autoSend.current = undefined
    if (step === 'send' && file && limits) void upload.submit(file, limits, measured ?? undefined)
  }, [file, limits, invalid, measuring, measured, refreshing, state.kind, upload])
  // Without the conditions nothing can be checked or sent.
  const pickDisabled = !limits || sending
  const described = `recognition-cloud-warning${invalid ? ' recognition-file-error' : ''}${limits ? '' : ' recognition-pick-wait'}`
  const conditions = useStickyOpen(config.kind === 'error' || (config.kind === 'ok' && config.refreshError !== undefined) || Boolean(executorNote?.warning))
  const conditionsTitle = <h2 id="recognition-limits-title" tabIndex={-1} data-request-focus-target>Условия загрузки</h2>
  const conditionsBody = <>
    {config.kind === 'loading' && <RequestState kind="loading" message="Получаем лимиты и токен безопасности…" />}
    {config.kind === 'error' && <RequestState kind="error" message={errorText(config.error)} onRetry={request.refresh} />}
    {config.kind === 'ok' && <>
      <p>Форматы: {config.data.limits.formats.map(formatName).join(', ')}. Максимальный размер: {formatBytes(config.data.limits.max_bytes)}. До {glue(config.data.limits.max_pixels.toLocaleString('ru-RU'), 'пикселей')} и {glue(config.data.limits.max_receipts.toLocaleString('ru-RU'), 'чеков')} на фото.{config.data.limits.max_pdf_pages !== undefined && <> PDF — до {glue(config.data.limits.max_pdf_pages.toLocaleString('ru-RU'), 'страниц')}: счёт или электронный чек, страницы станут одним изображением.</>}</p>
      {executorNote && <p className={executorNote.warning ? 'ck-rec-warning' : undefined}>{executorNote.text}</p>}
      <button type="button" className="ck-upload-secondary" disabled={sending || refreshing} onClick={refreshConfig}>Обновить условия загрузки</button>
      {config.refreshError && <p role="status" className="ck-rec-error">Не удалось обновить условия. {errorText(config.refreshError)}</p>}
    </>}
  </>
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (file && limits && !measuring) void upload.submit(file, limits, measured ?? undefined)
  }
  return <div className="ck-rec ck-upload">
    <form ref={formBlock} onSubmit={submit} className="ck-rec-panel ck-upload-card" aria-labelledby="recognition-file-title" aria-busy={sending}>
      <div className="ck-upload-head">
        <h2 id="recognition-file-title" tabIndex={-1} data-request-focus-target>Фото чека</h2>
        <p className="ck-upload-lead">Одно фото — один или несколько чеков{limits?.max_pdf_pages !== undefined && <>; PDF — до {glue(limits.max_pdf_pages, 'страниц')}</>}.</p>
      </div>
      {!limits && <p id="recognition-pick-wait" className="ck-rec-note">{config.kind === 'error' ? uploadLabels.conditionsFailed : uploadLabels.conditionsLoading}</p>}
      {file && <><p className="ck-upload-file">{file.name} · {formatName(fileFormat(file) ?? '') || 'Неподдерживаемый формат'} · {formatBytes(file.size)}{measured && <> · <Value>{sizeText(measured)}</Value></>}</p>{!invalid && (pdf
        ? <PdfPreview key={`${file.name}:${file.lastModified}:${file.size}`} file={file} maxPages={limits?.max_pdf_pages} />
        : <FilePreview key={`${file.name}:${file.lastModified}:${file.size}`} file={file} onMeasure={setMeasured} />)}</>}
      {invalid && <p id="recognition-file-error" role="status" className="ck-rec-error">{invalid}</p>}
      {state.reduced
        ? <p className="ck-upload-reduced">Фото больше лимита сервера, перед отправкой уменьшено до <Value>{sizeText(state.reduced)}</Value>. Отправляется уменьшенная копия: {formatBytes(state.reduced.file.size)}.</p>
        : plan?.kind === 'reduce' && <p className="ck-upload-reduced">Фото больше лимита сервера: перед отправкой оно будет уменьшено{plan.width && plan.height ? <> до <Value>{sizeText({ width: plan.width, height: plan.height })}</Value></> : null}.</p>}
      {/* The stage stands right above its bar. Only the change of a stage is announced: the bytes of the progress are outside the live region. */}
      <div role="status" aria-live="polite" className="ck-upload-stage">{sending && <p>{state.stage === 'reducing' ? uploadLabels.stageReducing : state.stage === 'waiting' ? uploadLabels.stageWaiting : uploadLabels.stageUploading}</p>}{state.kind === 'cancelled' && <p>{state.message}</p>}{state.kind === 'error' && <p className="ck-rec-error">{state.message}</p>}{state.kind === 'success' && <p>{state.message}</p>}</div>
      {sending && !reducing && outgoing && <UploadProgress sent={state.sent ?? 0} total={state.total ?? outgoing.size} />}
      {(state.kind === 'error' || (state.kind === 'cancelled' && state.message === uploadLabels.cancelled)) && <Link to="/recognition/jobs">Проверить список обработки</Link>}
      {/* The picking buttons stand low, right above the main action: in reach of the thumb on a phone. */}
      {/* «Снять чек» is the main action until a photo is chosen; then the main action is sending it. */}
      <div className="ck-rec-actions ck-upload-pick" role="group" aria-label="Выбор фото">
        <button type="button" className={`ck-upload-camera ck-upload-big${file ? ' ck-upload-secondary' : ''}`} disabled={pickDisabled} aria-describedby={described} onClick={() => cameraInput.current?.click()}>{cameraIcon}{uploadLabels.camera}</button>
        <button type="button" className="ck-upload-gallery ck-upload-big ck-upload-secondary" disabled={pickDisabled} aria-describedby={described} onClick={gallery.open}>{galleryIcon}{uploadLabels.gallery}</button>
        <button type="button" className="ck-upload-file-button ck-upload-big ck-upload-secondary" disabled={pickDisabled} aria-describedby={described} onClick={() => fileInput.current?.click()}>{fileIcon}{uploadLabels.pick}</button>
        <input ref={cameraInput} id="recognition-camera" className="ck-upload-input" type="file" accept="image/*" capture="environment" tabIndex={-1} aria-hidden="true" disabled={pickDisabled} onChange={(event) => pick(event, true)} />
        {gallery.field}
        <input ref={fileInput} id="recognition-file" className="ck-upload-input" type="file" accept={pickAccept} tabIndex={-1} aria-hidden="true" disabled={pickDisabled} onChange={(event) => pick(event, false)} />
      </div>
      <p id="recognition-cloud-warning" className="ck-upload-cloud">Фото передаётся облачной модели распознавания. Отправляйте только фото, которое вы готовы передать сервису.</p>
      {/* Sending waits for a chosen file: until then the big buttons above are the whole choice. */}
      {(file || sending) && <div className="ck-rec-actions ck-upload-send ck-action-bar">
        <button type="submit" className="ck-upload-submit" data-request-retry={repeat ? '' : undefined} disabled={!file || !limits || Boolean(invalid) || measuring || sending || refreshing}>{reducing ? uploadLabels.reducing : sending ? uploadLabels.sending : repeat ? uploadLabels.retry : uploadLabels.submit}</button>
        {sending && <button type="button" className="ck-upload-secondary" onClick={upload.cancel}>{uploadLabels.cancel}</button>}
      </div>}
    </form>
    <section ref={configBlock} className="ck-rec-panel ck-upload-card" aria-labelledby="recognition-limits-title" aria-busy={config.kind === 'loading'}>
      {/* On a phone the conditions fold into «Условия загрузки»; a failure or a missing worker opens them. */}
      {narrow
        ? <details className="ck-upload-conditions" open={conditions.open} onToggle={(event) => conditions.toggle(event.currentTarget.open)}>
          <summary>{conditionsTitle}{chevron}</summary>
          <div className="ck-upload-conditions-body">{conditionsBody}</div>
        </details>
        : <>{conditionsTitle}{conditionsBody}</>}
    </section>
    <nav className="ck-upload-links" aria-label="Обработка и траты">
      <Link to="/recognition/jobs">Обработка фото{chevron}</Link>
      <Link to="/receipts">Все траты{chevron}</Link>
    </nav>
  </div>
}
