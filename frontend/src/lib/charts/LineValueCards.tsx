import { Card, CardList } from '../cards'
import type { CardFact } from '../cards'
import type { LineChartPoint, LineChartSeries } from './LineChart.tsx'

/** A column of the table of values: the series gives the heading, its points give the cells. */
export interface LineValueColumn {
  item: Pick<LineChartSeries, 'key' | 'label'>
  points: readonly LineChartPoint[]
}

/** The phone view of the table of values: one card per interval, the interval is its heading and every series
    is a fact under the heading of its column. A series without data in the interval keeps the dash of the table. */
export default function LineValueCards({ label, caption, xs, columns, formatX }: {
  label: string; caption: string; xs: readonly string[]; columns: readonly LineValueColumn[]; formatX: (x: string) => string
}) {
  return (
    <CardList label={label} caption={caption}>
      {xs.map((x) => {
        const facts: CardFact[] = columns.map((entry) => ({
          key: entry.item.key, label: entry.item.label, value: entry.points.find((point) => point.x === x)?.valueText ?? '—',
        }))
        // The name of an interval is a value too: «сентябрь 2026», «неделя с 01.09.2026» stay whole inside <time>.
        return <Card key={x} title={<time dateTime={x}>{formatX(x)}</time>} facts={facts} />
      })}
    </CardList>
  )
}
