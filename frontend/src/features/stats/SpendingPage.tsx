import RequestState from '../../components/RequestState'
import { buildSpendingQuery, Link, spendingHref } from '../../navigation'
import type { SpendingPageProps } from '../../pages/types'

/** Placeholder until the spending screen is built: no request is made and no numbers are shown. */
export default function SpendingPage({ query }: SpendingPageProps) {
  const filtered = buildSpendingQuery(query) !== ''
  return (
    <section className="stats-spending" aria-labelledby="stats-spending-heading">
      <h2 id="stats-spending-heading">Траты по категориям и товарам</h2>
      <RequestState kind="empty"
        message={`Раздел в разработке: диаграмма и таблица трат появятся позже, данные пока не загружаются.${filtered ? ' Фильтры из адреса сохранены.' : ''}`}
        action={filtered ? <Link className="action-link" to={spendingHref()}>Сбросить фильтры</Link> : undefined} />
    </section>
  )
}
