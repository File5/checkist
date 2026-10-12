import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { getManualParse, requestManualParse } from '../../api/receipts'
import type { ManualParse, ManualParseDraft } from '../../api/receipts'
import { createPollingRequest } from '../recognition/polling'
import { todayISO } from './expense-form'
import { isActive, PARSE_TEXT_MAX, PARSE_WAIT_MS, parseOutcome, parseTexts, requestFailureMessage } from './parse-text'
import type { ParseView } from './parse-text'

export type TextHintViewProps = { text: string; view: ParseView; onText: (text: string) => void; onSubmit: () => void }

/** The hint itself, without the network: the markup tests render it directly. */
export function TextHintView({ text, view, onText, onSubmit }: TextHintViewProps) {
  const working = view.kind === 'working'
  const submit = (event: FormEvent) => { event.preventDefault(); onSubmit() }
  return <form className="expense-hint" onSubmit={submit} noValidate aria-busy={working}>
    <label htmlFor="expense-hint-text" className="expense-hint-label">{parseTexts.label}</label>
    <div className="expense-hint-row">
      <input id="expense-hint-text" type="text" autoComplete="off" enterKeyHint="go" maxLength={PARSE_TEXT_MAX}
        placeholder={parseTexts.placeholder} value={text} readOnly={working} aria-describedby="expense-hint-status"
        onChange={(event) => onText(event.target.value)} />
      <button type="submit" className="expense-hint-send" disabled={working || !text.trim()}>
        {working ? parseTexts.working : parseTexts.button}
      </button>
    </div>
    <p id="expense-hint-status" className={`expense-hint-status expense-hint-${view.kind}`}
      role={view.kind === 'failed' ? 'alert' : 'status'}>
      {view.kind === 'working' ? parseTexts.working : view.kind === 'filled' ? parseTexts.filled
        : view.kind === 'failed' ? view.message : ''}
    </p>
  </form>
}

/** POST the text, poll the request, hand the draft to the form. Nothing is saved here. */
export default function TextHint({ onFill }: { onFill: (draft: ManualParseDraft) => void }) {
  const [text, setText] = useState('')
  const [view, setView] = useState<ParseView>({ kind: 'idle' })
  const stop = useRef<() => void>(() => {})
  const fill = useRef(onFill)
  useEffect(() => { fill.current = onFill }, [onFill])
  useEffect(() => () => stop.current(), [])

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

  const submit = async () => {
    const value = text.trim()
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

  return <TextHintView text={text} view={view} onText={setText} onSubmit={() => { void submit() }} />
}
