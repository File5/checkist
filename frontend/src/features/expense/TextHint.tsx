import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { FormEvent } from 'react'
import { getManualParse, requestManualParse } from '../../api/receipts'
import type { ManualParse, ManualParseDraft } from '../../api/receipts'
import { createPollingRequest } from '../recognition/polling'
import { todayISO } from './expense-form'
import { isActive, PARSE_TEXT_MAX, PARSE_WAIT_MS, parseOutcome, parseTexts, requestFailureMessage } from './parse-text'
import type { ParseView } from './parse-text'
import { speechRecognition, transcript, voiceError } from './voice'
import type { Recognition } from './voice'

/** `voice` — the browser can listen: the mic button is shown. */
export type TextHintViewProps = { text: string; view: ParseView; onText: (text: string) => void; onSubmit: () => void; voice?: { listening: boolean; onToggle: () => void } }

/** The hint itself, without the network: the markup tests render it directly. */
export function TextHintView({ text, view, onText, onSubmit, voice }: TextHintViewProps) {
  const working = view.kind === 'working'
  const submit = (event: FormEvent) => { event.preventDefault(); onSubmit() }
  return <form className="expense-hint" onSubmit={submit} noValidate aria-busy={working}>
    <label htmlFor="expense-hint-text" className="expense-hint-label">{parseTexts.label}</label>
    <div className="expense-hint-row">
      <input id="expense-hint-text" type="text" autoComplete="off" enterKeyHint="go" maxLength={PARSE_TEXT_MAX}
        placeholder={parseTexts.placeholder} value={text} readOnly={working} aria-describedby="expense-hint-status"
        onChange={(event) => onText(event.target.value)} />
      {voice && <button type="button" className="expense-hint-mic" aria-pressed={voice.listening} disabled={working}
        aria-label={voice.listening ? 'Остановить запись' : 'Сказать голосом'} onClick={voice.onToggle}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0M12 17v4M8 21h8" />
        </svg>
      </button>}
      <button type="submit" className="expense-hint-send" disabled={working || !text.trim()}>
        {working ? parseTexts.working : parseTexts.button}
      </button>
    </div>
    <p id="expense-hint-status" className={`expense-hint-status expense-hint-${view.kind}`}
      role={view.kind === 'failed' ? 'alert' : 'status'}>
      {voice?.listening ? 'Слушаю… Скажите, что и за сколько купили.' : view.kind === 'working' ? parseTexts.working : view.kind === 'filled' ? parseTexts.filled
        : view.kind === 'failed' ? view.message : ''}
    </p>
  </form>
}

const noChanges = () => () => {}

/** POST the text, poll the request, hand the draft to the form. Nothing is saved here. */
export default function TextHint({ onFill }: { onFill: (draft: ManualParseDraft) => void }) {
  const [text, setText] = useState('')
  const [view, setView] = useState<ParseView>({ kind: 'idle' })
  const stop = useRef<() => void>(() => {})
  const fill = useRef(onFill)
  useEffect(() => { fill.current = onFill }, [onFill])
  useEffect(() => () => stop.current(), [])
  // The server render says «no mic»; the browser answers for itself.
  const canListen = useSyncExternalStore(noChanges, () => Boolean(speechRecognition()), () => false)
  const [listening, setListening] = useState(false)
  const recognition = useRef<Recognition | undefined>(undefined)
  useEffect(() => () => recognition.current?.abort(), [])

  const follow = (first: ManualParse, started: number) => {
    const settle = (parse: ManualParse) => {
      const next = parseOutcome(parse, Date.now() - started)
      if (next.kind === 'working') return false
      stop.current()
      setView(next)
      if (next.kind === 'filled' && parse.draft) fill.current(parse.draft)
      return true
    }
    if (settle(first)) return
    const request = createPollingRequest((signal) => getManualParse(first.id, { signal }), isActive)
    const unsubscribe = request.subscribe(() => {
      const state = request.getSnapshot()
      if (state.kind === 'ok') settle(state.data)
      else if (state.kind === 'error') {
        stop.current()
        setView({ kind: 'failed', message: requestFailureMessage(state.error) })
      }
    })
    // The worker may stay busy with a photo: the wait is bounded on the client too.
    const deadline = setTimeout(() => { stop.current(); setView({ kind: 'failed', message: parseTexts.slow }) }, PARSE_WAIT_MS)
    stop.current = () => { clearTimeout(deadline); unsubscribe(); request.dispose(); stop.current = () => {} }
    request.start()
  }

  const submit = async (spoken?: string) => {
    const value = (spoken ?? text).trim()
    if (!value || view.kind === 'working') return
    stop.current()
    setView({ kind: 'working' })
    const controller = new AbortController()
    stop.current = () => { controller.abort(); stop.current = () => {} }
    const result = await requestManualParse(value, todayISO(), { signal: controller.signal })
    if (controller.signal.aborted || result.kind === 'aborted') return
    stop.current = () => {}
    if (result.kind === 'error') { setView({ kind: 'failed', message: requestFailureMessage(result) }); return }
    follow(result.data, Date.now())
  }

  // The heard text fills the field as it comes; when the person stops talking it is sent like the button.
  const toggleVoice = () => {
    if (recognition.current) { recognition.current.stop(); return }
    const Recognition = speechRecognition()
    if (!Recognition) return
    const listener = new Recognition()
    let heard = ''
    let failed = false
    listener.lang = 'ru-RU'
    listener.interimResults = true
    listener.continuous = false
    listener.onresult = (event) => { heard = transcript(event.results); setText(heard) }
    listener.onerror = (event) => {
      const message = voiceError(event.error)
      failed = Boolean(message)
      if (message) setView({ kind: 'failed', message })
    }
    listener.onend = () => {
      recognition.current = undefined
      setListening(false)
      if (!failed && heard) void submit(heard)
    }
    recognition.current = listener
    setListening(true)
    setView({ kind: 'idle' })
    listener.start()
  }

  return <TextHintView text={text} view={view} onText={setText} onSubmit={() => { void submit() }}
    voice={canListen ? { listening, onToggle: toggleVoice } : undefined} />
}
