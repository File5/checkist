import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { FormEvent } from 'react'
import { getManualParse, getManualSuggestions, requestManualParse } from '../../api/receipts'
import type { ManualParse, ManualParseDraft, ManualSuggestion } from '../../api/receipts'
import ChipScroller from '../../components/ChipScroller'
import { formatMoney } from '../../lib/money'
import { createPollingRequest } from '../recognition/polling'
import { todayISO } from './expense-form'
import { isActive, PARSE_TEXT_MAX, PARSE_WAIT_MS, parseOutcome, parseTexts, requestFailureMessage } from './parse-text'
import type { ParseView } from './parse-text'
import { chipText, hasSearchWords, SUGGEST_DELAY_MS, suggestionMeta, suggestionTitle } from './suggestions'
import { speechRecognition, transcript, voiceError } from './voice'
import type { Recognition } from './voice'

/** `voice` — the browser can listen: the mic button is shown. `suggestions` — past spends that match the text (shown
 * while the text has words), `frequent` — repeated ones (shown while the field is empty); a tap is `onRepeat`. */
export type TextHintViewProps = {
  text: string; view: ParseView; onText: (text: string) => void; onSubmit: () => void; voice?: { listening: boolean; onToggle: () => void }
  suggestions?: ManualSuggestion[]; frequent?: ManualSuggestion[]; onRepeat?: (spend: ManualSuggestion) => void; today?: string
  /** The example in the empty field: «такси до аэропорта 4500», on «Доход» — «зарплата 650 000». */
  placeholder?: string
}

/** The hint itself, without the network: the markup tests render it directly. */
export function TextHintView({ text, view, onText, onSubmit, voice, suggestions = [], frequent = [], onRepeat = () => {}, today = todayISO(), placeholder = parseTexts.placeholder }: TextHintViewProps) {
  const working = view.kind === 'working'
  const submit = (event: FormEvent) => { event.preventDefault(); onSubmit() }
  const listed = !working && hasSearchWords(text) ? suggestions : []
  const chips = !working && !text.trim() ? frequent : []
  return <form className="expense-hint" onSubmit={submit} noValidate aria-busy={working}>
    <label htmlFor="expense-hint-text" className="expense-hint-label">{parseTexts.label}</label>
    <div className="expense-hint-row">
      <input id="expense-hint-text" type="text" autoComplete="off" enterKeyHint="go" maxLength={PARSE_TEXT_MAX}
        placeholder={placeholder} value={text} readOnly={working} aria-describedby="expense-hint-status"
        onChange={(event) => onText(event.target.value)} />
      {voice && <button type="button" className="expense-hint-mic" aria-pressed={voice.listening} disabled={working}
        aria-label={voice.listening ? 'Остановить запись' : 'Сказать голосом'} onClick={voice.onToggle}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
          <rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0M12 17v4M8 21h8" />
        </svg>
      </button>}
      <button type="submit" className="expense-hint-send" disabled={working || !text.trim()} aria-label={working ? parseTexts.working : parseTexts.button}>
        {working
          ? <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
          : <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M5 12h14M13 6l6 6-6 6" /></svg>}
      </button>
    </div>
    <p id="expense-hint-status" className={`expense-hint-status expense-hint-${view.kind}`}
      role={view.kind === 'failed' ? 'alert' : 'status'}>
      {voice?.listening ? 'Слушаю… Скажите, что и за сколько купили.' : view.kind === 'working' ? parseTexts.working : view.kind === 'filled' ? parseTexts.filled
        : view.kind === 'repeated' ? parseTexts.repeated : view.kind === 'failed' ? view.message : ''}
    </p>
    {listed.length > 0 && <ul className="ck-list expense-suggest" aria-label="Как в прошлый раз">
      {listed.map((spend) => <li key={spend.receipt_id}>
        <button type="button" className="ck-row expense-suggest-row" onClick={() => onRepeat(spend)}>
          <span className="ck-row-main">
            <span className="ck-row-title">{suggestionTitle(spend)}</span>
            <span className="ck-row-meta">{suggestionMeta(spend, today)}</span>
          </span>
          <span className="ck-row-amount">{formatMoney(spend.total, spend.currency)}</span>
        </button>
      </li>)}
    </ul>}
    {chips.length > 0 && <ChipScroller label="Частые траты" className="expense-frequent">
      <span className="expense-frequent-label" aria-hidden="true">Повторить:</span>
      {chips.map((spend) => <button key={spend.receipt_id} type="button" className="ck-chip" onClick={() => onRepeat(spend)}>{chipText(spend)}</button>)}
    </ChipScroller>}
  </form>
}

const noChanges = () => () => {}

/** Past spends for the text as it is typed, without the model: the frequent ones once, matching ones after a pause.
 * A failed request shows nothing — typing and the parse go on as before. */
function useSuggestions(text: string, enabled: boolean) {
  const [frequent, setFrequent] = useState<ManualSuggestion[]>([])
  const [found, setFound] = useState<{ text: string; spends: ManualSuggestion[] }>({ text: '', spends: [] })
  useEffect(() => {
    const controller = new AbortController()
    void getManualSuggestions('', { signal: controller.signal }).then((result) => { if (result.kind === 'ok') setFrequent(result.data) })
    return () => controller.abort()
  }, [])
  const query = text.trim()
  const wanted = enabled && hasSearchWords(query)
  useEffect(() => {
    if (!wanted) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void getManualSuggestions(query, { signal: controller.signal })
        .then((result) => { if (result.kind === 'ok') setFound({ text: query, spends: result.data }) })
    }, SUGGEST_DELAY_MS)
    return () => { clearTimeout(timer); controller.abort() }
  }, [query, wanted])
  return { frequent, suggestions: wanted && found.text === query ? found.spends : [] }
}

/** POST the text, poll the request, hand the draft to the form. Nothing is saved here. Under the field: past spends to
 * repeat with one tap (`onRepeat`); on «Доход» (`income`) past spends are not offered. */
export default function TextHint({ onFill, onRepeat, income = false }: { onFill: (draft: ManualParseDraft) => void; onRepeat: (spend: ManualSuggestion) => void; income?: boolean }) {
  const [text, setText] = useState('')
  const [view, setView] = useState<ParseView>({ kind: 'idle' })
  // After a fill the list hides until the text changes again.
  const [typed, setTyped] = useState(false)
  const { frequent, suggestions } = useSuggestions(text, typed)
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
    setTyped(false)
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

  const repeat = (spend: ManualSuggestion) => {
    stop.current()
    setText('')
    setTyped(false)
    setView({ kind: 'repeated' })
    onRepeat(spend)
  }
  return <TextHintView text={text} view={view} onText={(value) => { setText(value); setTyped(true) }} onSubmit={() => { void submit() }}
    voice={canListen ? { listening, onToggle: toggleVoice } : undefined} suggestions={income ? [] : suggestions} frequent={income ? [] : frequent}
    onRepeat={repeat} placeholder={income ? 'зарплата 650 000' : undefined} />
}
