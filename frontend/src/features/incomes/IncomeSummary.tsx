import { useEffect, useState } from 'react'
import { getIncomeSummary, INCOME_CHANGED } from '../../api/incomes'
import type { IncomeSummary as Summary } from '../../api/incomes'
import { Link } from '../../navigation'
import { summaryParts } from './incomes-state'
import './Incomes.css'

/** The line of «Главная» without loading: the markup tests render it directly. */
export function IncomeSummaryView({ data }: { data: Summary }) {
  const parts = summaryParts(data, data.base_currency)
  // No income yet is not a zero: the line asks for it.
  if (!parts) return <p className="ck-panel inc-summary inc-summary-empty">Доход не внесён — <Link to="/receipts/new?kind=income">добавить</Link></p>
  return <section className="ck-panel inc-summary" aria-label="Доход месяца">
    <dl className="inc-summary-list">
      {parts.map((part) => <div key={part.label} className="inc-summary-item">
        <dt>{part.label}</dt>
        <dd className="ck-figures">{part.value}{part.note && <span className="inc-summary-note"> ({part.note})</span>}</dd>
      </div>)}
    </dl>
    <Link className="inc-summary-link" to={`/incomes?month=${data.month}`}>Доходы</Link>
  </section>
}

/** «Доход N · Потрачено M · Отложено K (x %)» of the month on «Главная»; it loads by itself and again after an income
 * is added on the same screen (`INCOME_CHANGED`). */
export default function IncomeSummary({ month }: { month: string }) {
  const [loaded, setLoaded] = useState<{ month: string; data: Summary } | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    void getIncomeSummary(month, { signal: controller.signal }).then((result) => {
      if (result.kind === 'ok') setLoaded({ month, data: result.data })
    })
    return () => controller.abort()
  }, [month, attempt])
  useEffect(() => {
    const again = () => setAttempt((value) => value + 1)
    window.addEventListener(INCOME_CHANGED, again)
    return () => window.removeEventListener(INCOME_CHANGED, again)
  }, [])
  if (!loaded || loaded.month !== month) return null
  return <IncomeSummaryView data={loaded.data} />
}
