import RequestState from '../../components/RequestState'
import { buildReceiptsStatsQuery, Link, receiptsStatsHref } from '../../navigation'
import type { ReceiptsStatsPageProps } from '../../pages/types'

/** Placeholder until the average receipt screen is built: no request is made and no numbers are shown. */
export default function ReceiptsStatsPage({ query }: ReceiptsStatsPageProps) {
  const filtered = buildReceiptsStatsQuery(query) !== ''
  return (
    <section className="stats-receipts" aria-labelledby="stats-receipts-heading">
      <h2 id="stats-receipts-heading">Почему изменился средний чек</h2>
      <RequestState kind="empty"
        message={`Раздел в разработке: сравнение периодов и разбор изменения среднего чека появятся позже, данные пока не загружаются.${filtered ? ' Периоды и фильтры из адреса сохранены.' : ''}`}
        action={filtered ? <Link className="action-link" to={receiptsStatsHref()}>Сбросить фильтры</Link> : undefined} />
    </section>
  )
}
