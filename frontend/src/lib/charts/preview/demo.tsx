/* Synthetic data for the standalone preview of the chart components (charts-preview/index.html).
   Nothing here is used by the application; shops, products and sums are invented. */
import { formatAmount, formatPercent, formatPrice } from '../../format.ts'
import { LineChart, PieChart, chartNumber } from '../index.ts'
import type { LineChartSeries, PieChartItem } from '../index.ts'

const monthName = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' })
const monthTick = new Intl.DateTimeFormat('ru-RU', { month: 'short', year: '2-digit', timeZone: 'UTC' })
const formatMonth = (x: string) => monthName.format(new Date(`${x}T00:00:00Z`))
const formatMonthTick = (x: string) => monthTick.format(new Date(`${x}T00:00:00Z`))
const formatAxis = (value: number) => value.toLocaleString('ru-RU', { maximumFractionDigits: 2 })

type SpendingRow = { key: string; label: string; amount: string; tone?: PieChartItem['tone']; note?: string; link?: boolean }

function pieItems(rows: SpendingRow[]): PieChartItem[] {
  const positive = rows.reduce((sum, row) => sum + Math.max(0, chartNumber(row.amount) ?? 0), 0)
  return rows.map((row) => {
    const value = chartNumber(row.amount) ?? 0
    return {
      key: row.key, label: row.label, value, tone: row.tone, note: row.note,
      valueText: formatAmount(row.amount, 'EUR'),
      shareText: value > 0 ? formatPercent(((value / positive) * 100).toFixed(2)) : '—',
      href: row.link === false || row.tone ? undefined : `#${row.key}`,
    }
  })
}

const categories = pieItems([
  { key: 'food', label: 'Продукты питания', amount: '5590.75' },
  { key: 'unsorted', label: 'Не разобрано', amount: '5184.91', note: 'Категорию товарам назначают в админке.' },
  { key: 'household', label: 'Бытовая химия', amount: '1767.78' },
  { key: 'drinks', label: 'Напитки', amount: '402.10' },
  { key: 'pets', label: 'Товары для животных', amount: '96.40' },
  { key: 'other', label: 'Прочее (4 категории)', amount: '143.22', tone: 'other' },
  { key: 'unmatched', label: 'Строки без товара', amount: '336.88', tone: 'muted', note: 'Товар для строки чека не определён.' },
  { key: 'service', label: 'Услуги', amount: '18.00', tone: 'muted' },
  { key: 'deposit', label: 'Залог и возврат тары', amount: '-12.25', tone: 'muted' },
])
const products = pieItems(Array.from({ length: 11 }, (_, index) => ({
  key: `product-${index + 1}`, label: `Demo товар №${index + 1} с длинным названием для проверки переноса`, amount: (220 / (index + 1) ** 1.6 + 1.5).toFixed(2),
})))

const months = (year: number, from: number, values: (number | null)[]) => values.flatMap((value, index) => {
  if (value === null) return []
  const month = from + index
  const x = `${year + Math.floor((month - 1) / 12)}-${String(((month - 1) % 12) + 1).padStart(2, '0')}-01`
  return [{ x, value }]
})
const priceSeries = (key: string, label: string, values: (number | null)[], extra: Partial<LineChartSeries> = {}): LineChartSeries => ({
  key, label, ...extra,
  points: months(2025, 7, values).map((point) => ({ ...point, valueText: formatPrice(point.value.toFixed(4), 'EUR', 'pcs') })),
})
const prices: LineChartSeries[] = [
  priceSeries('s1', 'Zahlenfrisch, Musterstadt', [1.05, 1.05, 1.05, 1.09, 1.09, 1.09, 1.15, 1.15, null, null, 1.19, 1.19, 1.19, 1.25, 1.25]),
  priceSeries('s2', 'Billigmarkt, Musterstadt', [0.99, 0.99, null, 0.99, 1.05, 1.05, 1.05, null, 1.09, 1.09, 1.15, null, null, 1.15, 1.19]),
  priceSeries('s3', 'Eckladen, Beispielheim', [null, null, null, null, null, 1.39, null, null, null, null, null, null, null, null, null]),
  priceSeries('s4', 'Demo Vollmilch 3,5 % 1 л', [null, 1.19, 1.19, 1.19, 1.25, null, null, 1.29, 1.29, 1.29, 1.29, 1.35, 1.35, null, 1.35], { note: 'похожий товар · DE' }),
]
const receiptSeries = (key: string, label: string, shortLabel: string, values: (number | null)[]): LineChartSeries => ({
  key, label, shortLabel,
  points: months(2026, 1, values).map((point) => ({ ...point, valueText: formatAmount(point.value.toFixed(2), 'EUR') })),
})
const receipts: LineChartSeries[] = [
  receiptSeries('avg', 'Средний чек', 'средний', [45.12, 44.79, 46.62, 43.55, 46.36, null, 47.1, 48.02, 49.4]),
  receiptSeries('median', 'Медианный чек', 'медиана', [45.85, 44.32, 47.08, 45.1, 44.9, null, 46.2, 47.75, 47.9]),
]
const crowd: LineChartSeries[] = Array.from({ length: 10 }, (_, index) => priceSeries(
  `m${index}`, `Demo магазин ${index + 1}`,
  Array.from({ length: 15 }, (_, month) => ((index * 7 + month * 3) % 11 === 0 ? null : Number((0.9 + index * 0.07 + month * 0.012 + ((index + month) % 3) * 0.02).toFixed(2)))),
))

export default function ChartsDemo() {
  return (
    <div className="page">
      <main>
        <div className="intro">
          <p className="eyebrow">Ф1 · предпросмотр компонентов</p>
          <h1>Графики</h1>
          <p className="intro-note">
            Компоненты PieChart и LineChart на вымышленных данных. Это не экран приложения: запросов к серверу здесь нет,
            ссылки секторов ведут на якоря этой же страницы.
          </p>
        </div>
        <Example title="Круговая: траты по категориям" note="Наведите на сектор или строку таблицы, пройдите Tab по ссылкам. Сектор меньше 2 % подписан только в таблице, отрицательная сумма в круг не входит.">
          <PieChart title="Траты по категориям, EUR" items={categories} centerLabel="Сумма строк" centerValue={formatAmount('13527.79', 'EUR')} />
        </Example>
        <Example title="Круговая: один сектор 100 %" note="Полное кольцо без шва.">
          <PieChart title="Траты по магазинам, EUR" items={pieItems([{ key: 'store', label: 'Zahlenfrisch, Musterstadt', amount: '812.40', link: false }])} centerLabel="Всего" centerValue={formatAmount('812.40', 'EUR')} headers={{ name: 'Магазин', value: 'Сумма чеков', share: 'Доля' }} />
        </Example>
        <Example title="Круговая: 11 товаров" note="Девятый и следующие сектора повторяют цвета со штриховкой; подписи не наезжают друг на друга.">
          <PieChart title="Траты по товарам, EUR" items={products} />
        </Example>
        <Example title="Круговая: пустые данные">
          <PieChart title="Траты" items={[]} emptyMessage="За выбранный период трат нет." />
        </Example>
        <Example title="Линейная: цена товара по магазинам" note="Разрывы там, где покупок не было; третья серия — одна точка. Сфокусируйте график и нажимайте ← → Home End Esc; снимайте флажки серий.">
          <LineChart title="Цена за штуку, EUR" series={prices} interval="month" formatX={formatMonth} formatTick={formatMonthTick} formatValue={formatAxis} valueAxisLabel="EUR/шт" />
        </Example>
        <Example title="Линейная: средний и медианный чек" note="Ось значений от нуля, подписи у концов линий — короткие названия; в июне походов не было.">
          <LineChart title="Чек по месяцам, EUR" series={receipts} interval="month" zeroBaseline formatX={formatMonth} formatTick={formatMonthTick} formatValue={formatAxis} valueAxisLabel="EUR" />
        </Example>
        <Example title="Линейная: десять серий" note="Девятая и десятая серии повторяют цвет, но отличаются штрихом и маркером; часть серий выключена с самого начала.">
          <LineChart title="Цена за штуку по магазинам, EUR" series={crowd} interval="month" defaultHiddenKeys={['m6', 'm7', 'm8', 'm9']} formatX={formatMonth} formatTick={formatMonthTick} formatValue={formatAxis} />
        </Example>
        <Example title="Линейная: пустые данные">
          <LineChart title="Цена" series={[]} formatX={formatMonth} formatValue={formatAxis} emptyMessage="Покупок за выбранный период нет." />
        </Example>
      </main>
    </div>
  )
}

function Example({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="health-panel" style={{ marginBottom: 24, display: 'grid', gap: 14 }}>
      <h2>{title}</h2>
      {note && <p className="intro-note" style={{ margin: 0, maxWidth: 'none' }}>{note}</p>}
      {children}
    </section>
  )
}
