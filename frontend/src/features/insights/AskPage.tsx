import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { askQuestion, getAsk, getAsks } from '../../api/insights'
import type { Ask } from '../../api/insights'
import { Link, navigate } from '../../navigation'
import { follow } from './follow'
import { insightErrorMessage, insightTexts, isActive, modelText, QUESTION_MAX, requestFailureMessage } from './insights-state'
import './Insights.css'

/** The question on the screen: its words, then «Думаю…», the answer or a message. */
export type Current = { question: string; row: Ask | null; message: string | null }

const askedAt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })

/** What a past question shows under it. */
function pastText(row: Ask): string {
  if (row.answer) return modelText(row.answer.answer)
  if (row.status === 'failed') return insightErrorMessage(row.error?.code ?? '')
  return insightTexts.thinking
}

function Answer({ current }: { current: Current }) {
  const { row, message } = current
  const working = !message && (!row || isActive(row))
  return <section className="ck-panel ins-answer" aria-labelledby="ins-answer-heading" aria-busy={working}>
    <h2 id="ins-answer-heading" className="ins-question">{current.question}</h2>
    {working && <p className="ins-status" role="status">{insightTexts.thinking}</p>}
    {message && <p className="ins-status ins-status-failed" role="alert">{message}</p>}
    {row?.answer && <div className="ins-text">
      <p>{modelText(row.answer.answer)}</p>
      {row.unverified.length > 0 && <p className="ins-unverified">{insightTexts.unverified} {row.unverified.join(', ')}.</p>}
      <p className="ins-note">Ответил ИИ по цифрам семьи за 12 месяцев — он может ошибаться. Точные цифры — в разборе месяца.</p>
    </div>}
  </section>
}

export type AskViewProps = {
  text: string
  current: Current | null
  history: Ask[]
  onText?: (text: string) => void
  onSubmit?: () => void
}

/** `/ask` without loading: the markup tests render it directly. */
export function AskView({ text, current, history, onText = () => {}, onSubmit = () => {} }: AskViewProps) {
  const working = current !== null && !current.message && (!current.row || isActive(current.row))
  const submit = (event: FormEvent) => { event.preventDefault(); onSubmit() }
  const past = history.filter((row) => row.id !== current?.row?.id)
  return <div className="ins-page ins-ask-page">
    <form className="ck-panel ins-ask-form" onSubmit={submit} noValidate aria-busy={working}>
      <label htmlFor="ins-question-field" className="ins-label">Спросите о тратах семьи</label>
      <div className="ins-ask-row">
        <input id="ins-question-field" type="text" autoComplete="off" enterKeyHint="send" maxLength={QUESTION_MAX}
          placeholder="Сколько ушло на кафе в прошлом месяце?" value={text} readOnly={working} onChange={(event) => onText(event.target.value)} />
        <button type="submit" disabled={working || !text.trim()}>Спросить</button>
      </div>
      <p className="ins-note">Отвечаю по цифрам за 12 месяцев: категории, места, лимиты, регулярные платежи. Вопросы видите только вы.</p>
    </form>
    {current && <Answer current={current} />}
    <section className="ck-panel" aria-labelledby="ins-history-heading">
      <div className="ck-panel-head"><h2 id="ins-history-heading">Прошлые вопросы</h2><Link to="/review">Разбор месяца</Link></div>
      {past.length
        ? <ul className="ck-list ins-history">{past.map((row) => <li key={row.id} className="ins-past">
          <p className="ins-past-question">{row.question}</p>
          <p className={`ins-past-answer${row.status === 'failed' ? ' ins-status-failed' : ''}`}>{pastText(row)}</p>
          <p className="ins-note"><time dateTime={row.created_at}>{askedAt.format(new Date(row.created_at))}</time></p>
        </li>)}</ul>
        : <p className="ins-note">Здесь будут ваши вопросы и ответы.</p>}
    </section>
  </div>
}

/** `/ask?q=`: a question about the spends; with `q` it is asked at once (and the address forgets it: a reload does not
 * ask again). The answer is polled like «Трата словами»; the person's own past questions are listed under it. */
export default function AskPage({ q }: { q?: string }) {
  const [text, setText] = useState(q ?? '')
  const [current, setCurrent] = useState<Current | null>(null)
  const [history, setHistory] = useState<Ask[]>([])
  const stop = useRef<() => void>(() => {})
  const asked = useRef(false)
  // A sent question is not taken back when the screen goes (its answer lands in the history): only the latest question
  // of a screen still on view fills it.
  const alive = useRef(false)
  const latest = useRef(0)

  const reloadHistory = useCallback(() => {
    void getAsks().then((result) => { if (alive.current && result.kind === 'ok') setHistory(result.data.results) })
  }, [])

  const ask = useCallback((value: string) => {
    const question = value.trim()
    if (!question) return
    stop.current()
    const turn = ++latest.current
    setCurrent({ question, row: null, message: null })
    void askQuestion(question).then((result) => {
      if (!alive.current || turn !== latest.current || result.kind === 'aborted') return
      if (result.kind === 'error') { setCurrent({ question, row: null, message: requestFailureMessage(result) }); return }
      setCurrent({ question, row: result.data, message: null })
      setText('')
      stop.current = follow(result.data, (id, signal) => getAsk(id, { signal }),
        (row) => { setCurrent({ question, row, message: null }); reloadHistory() },
        (message) => setCurrent((before) => ({ question, row: before?.row ?? null, message })))
    })
  }, [reloadHistory])

  useEffect(() => {
    alive.current = true
    reloadHistory()
    return () => { alive.current = false; stop.current() }
  }, [reloadHistory])
  useEffect(() => {
    if (!q || asked.current) return
    asked.current = true
    ask(q)
    navigate('/ask', { replace: true })
  }, [q, ask])

  return <AskView text={text} current={current} history={history} onText={setText} onSubmit={() => ask(text)} />
}
