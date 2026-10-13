import { useCallback, useEffect, useRef, useState } from 'react'
import { getReview, getReviewRequest, requestReview } from '../../api/insights'
import type { Figure, Review, ReviewFigures, ReviewMonth } from '../../api/insights'
import Icon from '../../components/Icon'
import RequestState from '../../components/RequestState'
import { formatCents, formatMoney } from '../../lib/money'
import { buildRoute, Link } from '../../navigation'
import { cents, compareMonths, dashboardErrorMessage, deviceMonth, inMonth, monthTitle, plural, shiftMonth } from '../dashboard/dashboard-state'
import { follow } from './follow'
import {
  defaultReviewMonth, delta, insightErrorMessage, insightTexts, isActive, modelText, monthIsEmpty, requestFailureMessage,
} from './insights-state'
import './Insights.css'

/** What the card of the model says besides its text: idle, waiting (a first review or «Обновить»), or a message. */
export type ReviewStatus = { kind: 'idle' } | { kind: 'working'; refreshing: boolean } | { kind: 'message'; text: string }

const madeAt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })

/** «▲ 73 893 ₸» beside an amount: more — the over tint, less — the success tint. */
export function DeltaBadge({ change, currency, label }: { change: string | null; currency: string; label: string }) {
  const value = delta(change, currency)
  if (!value || value.tone === 'same') return null
  return <span className={`ins-delta ins-delta-${value.tone}`} aria-label={`${label}: ${value.tone === 'more' ? 'больше' : 'меньше'} на ${value.text.slice(2)}`}>{value.text}</span>
}

/** «Август: 125 075 ₸ · среднее 120 305 ₸». */
function compareMeta(figure: Figure, month: string, currency: string): string {
  const parts = [`${monthTitle(shiftMonth(month, -1)).split('\u00a0')[0]}: ${formatMoney(figure.previous, currency)}`]
  if (figure.average !== null) parts.push(`среднее ${formatMoney(figure.average, currency)}`)
  return parts.join(' · ')
}

/** The model's words: plain text only, never markup. */
function AiText({ review }: { review: Review }) {
  const answer = review.answer
  if (!answer) return null
  return <div className="ins-text">
    <p>{modelText(answer.summary)}</p>
    {answer.changes && <><h3>Что изменилось</h3><p>{modelText(answer.changes)}</p></>}
    {answer.limits && <><h3>Лимиты</h3><p>{modelText(answer.limits)}</p></>}
    {answer.advice.length > 0 && <><h3>Советы</h3><ol className="ins-advice">{answer.advice.map((item, index) => <li key={index}>{modelText(item)}</li>)}</ol></>}
    {review.unverified.length > 0 && <p className="ins-unverified">{insightTexts.unverified} {review.unverified.join(', ')}.</p>}
    <p className="ins-note">Текст написал ИИ {madeAt.format(new Date(review.created_at))} — он может ошибаться, цифры рядом считает сервер.</p>
  </div>
}

export type ReviewViewProps = {
  month: string
  figures: ReviewFigures
  review: Review | null
  status: ReviewStatus
  onRefresh?: () => void
  /** The month of the device: no «›» to a later one. */
  current?: string
}

/** `/review` without loading: the markup tests render it directly. */
export function ReviewView({ month, figures, review, status, onRefresh = () => {}, current = deviceMonth() }: ReviewViewProps) {
  const currency = figures.currency
  const compare = compareMonths(figures.spent, figures.previous, shiftMonth(month, -1))
  const working = status.kind === 'working'
  const empty = monthIsEmpty(figures)
  return <div className="ins-page">
    <div className="ins-col">
      <section className="ck-panel ins-hero" aria-labelledby="ins-month-heading">
        <div className="ins-month">
          <Link className="ck-round" to={buildRoute({ kind: 'review', month: shiftMonth(month, -1) })} aria-label="Предыдущий месяц"><Icon name="back" size={20} /></Link>
          <h2 id="ins-month-heading">{monthTitle(month)}</h2>
          {month < current ? <Link className="ck-round" to={buildRoute({ kind: 'review', month: shiftMonth(month, 1) })} aria-label="Следующий месяц"><Icon name="forward" size={20} /></Link>
            : <span className="ins-month-gap" aria-hidden="true" />}
        </div>
        <p className="ins-label">Потрачено {inMonth(month)}</p>
        <p className="ins-total ck-hero-figure">{formatMoney(figures.spent, currency)}</p>
        {compare && <p className={`ins-compare ins-compare-${compare.tone}`}>{compare.text[0].toUpperCase() + compare.text.slice(1)}</p>}
        {figures.average !== null && <p className="ins-compare">Среднее прошлых месяцев — <span className="ins-value">{formatMoney(figures.average, currency)}</span>{' '}
          <DeltaBadge change={figures.change_average} currency={currency} label="К среднему" /></p>}
        {figures.without_rate.length > 0 && <p className="ins-note">Без курса и не в цифрах: {figures.without_rate.map((item) => formatMoney(item.total, item.currency)).join(', ')}.</p>}
      </section>

      <section className="ck-panel ins-ai" aria-labelledby="ins-ai-heading" aria-busy={working}>
        <div className="ck-panel-head">
          <h2 id="ins-ai-heading">Что говорит ИИ</h2>
          {!empty && <button type="button" className="ck-button-secondary ins-refresh" disabled={working} onClick={onRefresh}>Обновить</button>}
        </div>
        {working && <p className="ins-status" role="status">{status.refreshing ? insightTexts.refreshing : insightTexts.working}</p>}
        {status.kind === 'message' && <p className="ins-status ins-status-failed" role="alert">{status.text}</p>}
        {review ? <AiText review={review} /> : !working && empty && <p className="ins-status">{insightTexts.empty}</p>}
        <Link className="ins-link" to="/ask">Спросить о тратах</Link>
      </section>
    </div>

    <div className="ins-col">
      {figures.categories.length > 0 && <section className="ck-panel" aria-labelledby="ins-cat-heading">
        <div className="ck-panel-head"><h2 id="ins-cat-heading">Куда ушли деньги</h2></div>
        <ul className="ck-list">{figures.categories.map((item) => <li key={item.id} className="ck-row">
          <span className="ck-row-main">
            <span className="ck-row-title">{item.name}</span>
            <span className="ck-row-meta ins-meta">{compareMeta(item, month, currency)}</span>
          </span>
          <span className="ins-amount">
            <span className="ck-row-amount ck-figures">{formatMoney(item.spent, currency)}</span>
            <DeltaBadge change={item.change_previous} currency={currency} label={`${item.name} к прошлому месяцу`} />
          </span>
        </li>)}</ul>
      </section>}

      {figures.limits.length > 0 && <section className="ck-panel" aria-labelledby="ins-limit-heading">
        <div className="ck-panel-head"><h2 id="ins-limit-heading">Лимиты</h2><Link to="/budget/limits">Изменить</Link></div>
        <ul className="ck-list">{figures.limits.map((item) => <li key={item.category} className="ck-row">
          <span className="ck-row-main">
            <span className="ck-row-title">{item.category}</span>
            <span className="ck-row-meta ins-meta">Лимит {formatMoney(item.limit, currency)} · <span className={item.over ? 'ins-over' : undefined}>
              {item.over ? `сверх на ${formatMoney(item.over, currency)}` : `осталось ${formatCents(cents(item.limit) - cents(item.spent), currency)}`}</span></span>
          </span>
          <span className="ck-row-amount ck-figures">{formatMoney(item.spent, currency)}</span>
        </li>)}</ul>
      </section>}

      {figures.places.length > 0 && <section className="ck-panel" aria-labelledby="ins-place-heading">
        <div className="ck-panel-head"><h2 id="ins-place-heading">Где тратили</h2></div>
        <ul className="ck-list">{figures.places.map((item) => <li key={item.name} className="ck-row">
          <span className="ck-row-main">
            <span className="ck-row-title">{item.name}</span>
            <span className="ck-row-meta">{item.count} {plural(item.count, 'трата', 'траты', 'трат')}</span>
          </span>
          <span className="ck-row-amount ck-figures">{formatMoney(item.spent, currency)}</span>
        </li>)}</ul>
      </section>}
    </div>
  </div>
}

type Load = { kind: 'ok'; data: ReviewMonth } | { kind: 'error'; message: string }

/** `/review?month=`: the figures of the month from the server and the review of the model next to them. The first
 * open of a month asks for a review (it is kept per person and month); «Обновить» asks again. */
export default function ReviewPage({ month = defaultReviewMonth() }: { month?: string }) {
  const [load, setLoad] = useState<Load>()
  const [attempt, setAttempt] = useState(0)
  const [shown, setShown] = useState<Review | null>(null)
  const [status, setStatus] = useState<ReviewStatus>({ kind: 'idle' })
  const stop = useRef<() => void>(() => {})

  const watch = useCallback((row: Review, refreshing: boolean) => {
    stop.current()
    setStatus({ kind: 'working', refreshing })
    stop.current = follow(row, (id, signal) => getReviewRequest(id, { signal }),
      (done) => { setShown(done); setStatus({ kind: 'idle' }) },
      (text) => setStatus({ kind: 'message', text }))
  }, [])

  const ask = useCallback((refreshing: boolean) => {
    stop.current()
    setStatus({ kind: 'working', refreshing })
    const controller = new AbortController()
    stop.current = () => controller.abort()
    void requestReview(month, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted || result.kind === 'aborted') return
      if (result.kind === 'error') setStatus({ kind: 'message', text: requestFailureMessage(result) })
      else watch(result.data, refreshing)
    })
  }, [month, watch])

  useEffect(() => {
    const controller = new AbortController()
    void getReview(month, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted || result.kind === 'aborted') return
      if (result.kind === 'error') { setLoad({ kind: 'error', message: dashboardErrorMessage(result) }); return }
      setLoad({ kind: 'ok', data: result.data })
      const { review, pending, figures } = result.data
      if (review?.status === 'succeeded') setShown(review)
      if (pending) watch(pending, true)
      else if (review && isActive(review)) watch(review, false)
      else if (review?.status === 'failed') setStatus({ kind: 'message', text: insightErrorMessage(review.error?.code ?? '') })
      // The first open of a month with spends asks for its review; an empty month costs no request to the model.
      else if (!review && !monthIsEmpty(figures)) ask(false)
    })
    return () => { controller.abort(); stop.current() }
  }, [month, attempt, watch, ask])

  if (!load) return <RequestState kind="loading" message="Загружаем цифры месяца…" />
  if (load.kind === 'error') return <RequestState kind="error" message={load.message} onRetry={() => setAttempt((value) => value + 1)} />
  return <ReviewView month={load.data.month} figures={shown?.figures ?? load.data.figures} review={shown} status={status}
    onRefresh={() => ask(shown !== null)} />
}
