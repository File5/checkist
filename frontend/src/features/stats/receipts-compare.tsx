import { useId, useMemo } from 'react'
import type { CompareCurrency, CompareProduct, ComparePriceIndex, ReceiptCompare } from '../../api/stats'
import RequestState from '../../components/RequestState'
import { useLocalRequestFocus } from '../../components/useLocalRequestFocus'
import { formatAmount, formatPrice, formatQuantity } from '../../lib/format'
import { Link, receiptsStatsHref } from '../../navigation'
import type { ReceiptsStatsQuery } from '../../navigation'
import { canRetry, failureMessage, hasScope, withoutScope } from './receipts-state'
import type { CompareState } from './receipts-state'
import {
  decompositionBar, indexAssumption, periodLabel, priceIndexSummary, refundsNote, sideFacts, signedAmount, signedPercent, verdict,
} from './receipts-wording'
import type { BarSegment, EffectPart, Verdict } from './receipts-wording'

const count = (value: number) => value.toLocaleString('ru-RU')

function Decomposition({ block, result }: { block: CompareCurrency; result: Verdict }) {
  const { parts } = result
  const bar = decompositionBar(parts)
  const segment = (item: BarSegment) => (
    <span key={item.key} className={`stats-bar-segment stats-effect-${item.key}`} data-sign={item.sign < 0 ? 'negative' : 'positive'}
      style={{ width: `${item.share}%` }} title={item.title} />
  )
  return (
    <section className="stats-decomposition">
      <h5>Из чего сложилось изменение</h5>
      {bar && <div className="stats-bar" aria-hidden="true">
        <div className="stats-bar-track">
          {bar.negative.map(segment)}
          <span className="stats-bar-zero" />
          {bar.positive.map(segment)}
        </div>
        <div className="stats-bar-scale">
          {bar.negative.length > 0 && <span>← уменьшает чек</span>}
          {bar.positive.length > 0 && <span className="stats-bar-scale-end">увеличивает чек →</span>}
        </div>
      </div>}
      <div className="stats-table-scroll">
        <table className="stats-table">
          <caption>
            Слагаемые в сумме дают изменение среднего чека точно. Полоса над таблицей показывает те же числа: заштрихованные части уменьшают чек.
          </caption>
          <thead>
            <tr><th scope="col">Слагаемое</th><th scope="col" className="stats-number">Вклад</th><th scope="col" className="stats-number">Доля изменения</th></tr>
          </thead>
          <tbody>
            {parts.map((part: EffectPart) => (
              <tr key={part.key}>
                <th scope="row">
                  <span className={`stats-swatch stats-effect-${part.key}`} data-sign={part.sign < 0 ? 'negative' : 'positive'} aria-hidden="true" />
                  <span className="stats-effect-title">{part.title}</span>
                  <span className="stats-effect-phrase">{part.phrase}{part.against && ' — действует против общего изменения'}</span>
                </th>
                <td className="stats-number">{signedAmount(part.amount, block.currency)}</td>
                <td className="stats-number">{part.percent === null ? '—' : signedPercent(part.percent)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Изменение среднего чека</th>
              <td className="stats-number">{signedAmount(block.change.avg_receipt, block.currency)}</td>
              <td className="stats-number">{block.change.avg_receipt_percent === null ? '—' : `${signedPercent(block.change.avg_receipt_percent)} к базовому чеку`}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      {result.note && <p className="stats-note">{result.note}</p>}
    </section>
  )
}

function PriceIndex({ index }: { index: ComparePriceIndex }) {
  const summary = priceIndexSummary(index)
  return (
    <section className="stats-index">
      <h5>Индекс цен</h5>
      <p className="stats-index-headline">{summary.headline}</p>
      <p className="stats-note">{summary.detail}</p>
      <p>{summary.matched} {summary.coverage}</p>
      {summary.warning && <p className="stats-warning" role="note"><strong>Внимание.</strong> {summary.warning}</p>}
      <p className="stats-note">{indexAssumption}</p>
    </section>
  )
}

function Products({ block }: { block: CompareCurrency }) {
  const id = useId()
  const { currency, products, products_total: total } = block
  if (products.length === 0) return null
  const row = (item: CompareProduct) => (
    <tr key={`${item.product.id}-${item.unit}`}>
      <th scope="row"><Link to={{ kind: 'product', productId: item.product.id, query: { page: 1 } }}>{item.product.name}</Link></th>
      <td className="stats-number">{formatPrice(item.base.price, currency, item.unit)}</td>
      <td className="stats-number">{formatPrice(item.current.price, currency, item.unit)}</td>
      <td className="stats-number">{signedPercent(item.price_change_percent)}</td>
      <td className="stats-number">{formatQuantity(item.base.quantity, item.unit)}</td>
      <td className="stats-number">{formatQuantity(item.current.quantity, item.unit)}</td>
      <td className="stats-number">{formatAmount(item.base.amount, currency)}</td>
      <td className="stats-number">{formatAmount(item.current.amount, currency)}</td>
    </tr>
  )
  return (
    <section className="stats-products">
      <h5 id={id}>Товары, купленные в обоих периодах</h5>
      <div className="stats-table-scroll" role="region" aria-labelledby={id} tabIndex={0}>
        <table className="stats-table stats-products-table">
          <caption>
            {products.length < total
              ? `Показаны ${count(products.length)} из ${count(total)} совпавших товаров с наибольшим изменением суммы покупок.`
              : `Все совпавшие товары (${count(total)}), по убыванию изменения суммы покупок.`}
            {' '}Цена — оплаченная сумма, делённая на количество за период.
          </caption>
          <thead>
            <tr>
              <th scope="col">Товар</th>
              <th scope="col" className="stats-number">Цена было</th><th scope="col" className="stats-number">Цена стало</th>
              <th scope="col" className="stats-number">Изменение цены</th>
              <th scope="col" className="stats-number">Куплено было</th><th scope="col" className="stats-number">Куплено стало</th>
              <th scope="col" className="stats-number">Сумма было</th><th scope="col" className="stats-number">Сумма стало</th>
            </tr>
          </thead>
          <tbody>{products.map(row)}</tbody>
        </table>
      </div>
    </section>
  )
}

/** Everything about one currency: the answer in words, both periods, the terms, the price index and the products. */
export function CompareCurrencySection({ block, data }: { block: CompareCurrency; data: Pick<ReceiptCompare, 'base' | 'current'> }) {
  const id = useId()
  const result = verdict(block)
  const refunds = refundsNote(block)
  const side = (title: string, key: 'base' | 'current') => (
    <section className="stats-side">
      <h5>{title}</h5>
      <p className="stats-note">{periodLabel(data[key])}</p>
      <dl className="stats-facts">
        {sideFacts(block[key], block.currency).map(([label, value]) => <div key={label}><dt>{label}</dt><dd className="stats-number">{value}</dd></div>)}
      </dl>
    </section>
  )
  return (
    <article className="stats-currency" aria-labelledby={id}>
      <h4 id={id}>{block.currency}</h4>
      <div className="stats-verdict" data-kind={result.kind}>
        <p className="stats-verdict-headline">{result.headline}</p>
        {result.lead && <p>{result.lead}</p>}
        {result.parts.length > 0 && <ul className="stats-verdict-parts">
          {result.parts.map((part) => (
            <li key={part.key}>
              <strong>{signedAmount(part.amount, block.currency)}</strong>
              {part.percent !== null && ` (${signedPercent(part.percent)} изменения)`} — {part.phrase}{part.against && ', против общего изменения'}
            </li>
          ))}
        </ul>}
        {result.parts.length === 0 && result.note && <p className="stats-note">{result.note}</p>}
      </div>
      <div className="stats-sides">{side('Базовый период', 'base')}{side('Текущий период', 'current')}</div>
      {refunds && <p className="stats-note">{refunds}</p>}
      {result.parts.length > 0 && <Decomposition block={block} result={result} />}
      {block.price_index && <PriceIndex index={block.price_index} />}
      <Products block={block} />
    </article>
  )
}

function CompareBody({ state, query, onRetry }: CompareBlockProps) {
  switch (state.kind) {
    case 'idle': return <RequestState kind="empty"
      message="Выберите базовый и текущий периоды в форме выше или готовую пару периодов — здесь появится разбор: изменился ли средний чек и что на него повлияло." />
    case 'invalid': return <RequestState kind="empty"
      message={`Сравнение не построено. ${[...new Set(Object.values(state.errors))].join(' ')} Исправьте отмеченные поля в форме выше.`} />
    case 'loading': return <RequestState kind="loading" message="Считаем сравнение периодов…" />
    case 'error': return canRetry(state)
      ? <RequestState kind="error" message={failureMessage(state)} onRetry={onRetry} />
      : <RequestState kind="empty" message={failureMessage(state)}
        action={<Link className="action-link" to={receiptsStatsHref(query.interval ? { interval: query.interval } : {})}>Сбросить периоды и фильтры</Link>} />
    case 'ok': {
      const { data } = state
      if (data.currencies.length === 0) {
        return hasScope(query)
          ? <RequestState kind="empty" message="По выбранным стране, валюте и магазинам походов нет ни в одном из периодов."
            action={<Link className="action-link" to={receiptsStatsHref(withoutScope(query))}>Убрать фильтры, оставить периоды</Link>} />
          : <RequestState kind="empty" message="Ни в базовом, ни в текущем периоде походов в магазин нет. Выберите другие периоды; чеки появляются после распознавания фото." />
      }
      return (
        <>
          {data.currencies.length > 1 && <p className="stats-note">
            Валюты не складываются и не пересчитываются: по каждой валюте чеков — свой разбор.
          </p>}
          {data.currencies.map((block) => <CompareCurrencySection key={block.currency} block={block} data={data} />)}
        </>
      )
    }
  }
}

export interface CompareBlockProps { state: CompareState; query: ReceiptsStatsQuery; onRetry: () => void }
/** The comparison block; it stays mounted through every state so that local focus has where to return. */
export default function CompareBlock(props: CompareBlockProps) {
  const id = useId()
  const { state } = props
  const phase = useMemo(() => ({ kind: state.kind === 'loading' ? 'loading' as const : state.kind === 'error' || state.kind === 'invalid' ? 'error' as const : 'ok' as const }), [state])
  const block = useLocalRequestFocus<HTMLElement>(phase)
  return (
    <section ref={block} className="stats-panel" aria-labelledby={id} aria-busy={state.kind === 'loading'}>
      <h3 id={id} data-request-focus-target tabIndex={-1}>Что изменилось между периодами</h3>
      <CompareBody {...props} />
    </section>
  )
}
