/* Synthetic data for the standalone preview of the charts under a finger (charts-touch-preview/index.html).
   Nothing here is used by the application; shops, products and sums are invented, the links lead to anchors. */
import { useState } from 'react'
import type { ReactNode } from 'react'
import { formatAmount, formatPercent, formatPrice } from '../../format.ts'
import { LineChart, PieChart } from '../index.ts'
import type { LineChartSeries, PieChartItem } from '../index.ts'

const monthName = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' })
const monthTick = new Intl.DateTimeFormat('ru-RU', { month: 'short', year: '2-digit', timeZone: 'UTC' })
const dayName = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' })
const dayTick = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', timeZone: 'UTC' })
const date = (x: string) => new Date(`${x}T00:00:00Z`)
const formatAxis = (value: number) => value.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const monthStart = (index: number) => `${2025 + Math.floor((6 + index) / 12)}-${String(((6 + index) % 12) + 1).padStart(2, '0')}-01`
const priceSeries = (key: string, label: string, values: (number | null)[], note?: string): LineChartSeries => ({
  key, label, note,
  points: values.flatMap((value, index) => (value === null ? [] : [{ x: monthStart(index), value, valueText: formatPrice(value.toFixed(4), 'EUR', 'pcs') }])),
})
const prices: LineChartSeries[] = [
  priceSeries('s1', 'Zahlenfrisch, Musterstadt', [1.05, 1.05, 1.05, 1.09, 1.09, 1.09, 1.15, 1.15, null, null, 1.19, 1.19, 1.19, 1.25, 1.25]),
  priceSeries('s2', 'Billigmarkt, Musterstadt', [0.99, 0.99, null, 0.99, 1.05, 1.05, 1.05, null, 1.09, 1.09, 1.15, null, null, 1.15, 1.19]),
  priceSeries('s3', 'Demo Vollmilch 3,5 % 1 л', [null, 1.19, 1.19, 1.19, 1.25, null, null, 1.29, 1.29, 1.29, 1.29, 1.35, 1.35, null, 1.35], 'похожий товар · DE'),
]
/* 52 weeks: on a phone an interval is narrower than a finger, which is what the step buttons are for. */
const weeks: LineChartSeries[] = [{
  key: 'avg', label: 'Средний чек', shortLabel: 'средний',
  points: Array.from({ length: 52 }, (_, index) => {
    const x = new Date(Date.UTC(2025, 9, 6 + index * 7)).toISOString().slice(0, 10)
    const value = 38 + ((index * 37) % 17) * 0.9 + index * 0.12
    return { x, value, valueText: formatAmount(value.toFixed(2), 'EUR') }
  }),
}]

const spending: [string, string, string][] = [
  ['food', 'Продукты питания', '5590.75'], ['household', 'Бытовая химия', '1767.78'], ['drinks', 'Напитки', '402.10'],
  ['pets', 'Товары для животных с длинным названием для проверки переноса строки', '96.40'], ['sweets', 'Сладости', '14.20'],
]
const total = spending.reduce((sum, row) => sum + Number(row[2]), 0)
const categories: PieChartItem[] = [
  ...spending.map(([key, label, amount]): PieChartItem => ({
    key, label, value: Number(amount), valueText: formatAmount(amount, 'EUR'),
    shareText: formatPercent(((Number(amount) / total) * 100).toFixed(2)), href: `#${key}`,
  })),
  { key: 'deposit', label: 'Залог и возврат тары', value: -12.25, valueText: formatAmount('-12.25', 'EUR'), shareText: '—', tone: 'muted' },
]

/* Only for looking at the page with a mouse: the real rules sit under `@media (pointer: coarse)` in Charts.css
   and need a phone or the device mode of the browser tools. The two rules repeat them word for word. */
const forced = `
.demo-coarse .ck-line-steps { display: grid; }
.demo-coarse .ck-chart .ck-pie-legend tbody a { display: inline-flex; align-items: center; min-height: 44px; }
`

export default function TouchDemo() {
  const [light, setLight] = useState(false)
  const [coarse, setCoarse] = useState(false)
  const toggleTheme = () => {
    const next = !light
    setLight(next)
    if (next) document.documentElement.setAttribute('data-theme', 'light')
    else document.documentElement.removeAttribute('data-theme')
  }
  return (
    <div className={coarse ? 'page demo-coarse' : 'page'}>
      <style>{forced}</style>
      <main>
        <div className="intro">
          <p className="eyebrow">Г · предпросмотр компонентов</p>
          <h1>Графики под палец</h1>
          <p className="intro-note">
            Настоящие компоненты LineChart и PieChart на вымышленных данных. Это не экран приложения: запросов к серверу нет,
            ссылки ведут на якоря этой же страницы (после перехода в адресе появляется «#…»). Жесты проверяются на телефоне
            либо в режиме устройства в инструментах браузера: там же появляются кнопки шага и высокие ссылки легенды.
          </p>
        </div>
        <section className="health-panel" style={{ marginBottom: 24, display: 'grid', gap: 14 }}>
          <h2>Настройки страницы</h2>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minHeight: 44 }}>
            <input type="checkbox" style={{ width: 18, height: 18, minHeight: 0, margin: 0 }} checked={coarse} onChange={() => setCoarse(!coarse)} />
            Показать кнопки шага и высокие ссылки легенды и при мыши (только на этой странице)
          </label>
          <p><button type="button" onClick={toggleTheme}>{light ? 'Тёмная тема' : 'Светлая тема'}</button></p>
        </section>
        <Example title="Линейный: цена по магазинам, 15 месяцев"
          note="Пальцем: касание выбирает интервал, повторное касание того же интервала снимает выделение; ведение вбок двигает выделение; прокрутка вверх-вниз поверх графика ничего не выбирает; касание вне графика снимает выделение. Мышь и клавиши ← → Home End Esc — как раньше.">
          <LineChart title="Цена за штуку, EUR" series={prices} interval="month" formatX={(x) => monthName.format(date(x))}
            formatTick={(x) => monthTick.format(date(x))} formatValue={formatAxis} valueAxisLabel="EUR/шт" />
        </Example>
        <Example title="Линейный: средний чек, 52 недели"
          note="Интервал на телефоне у́же пальца: выберите касанием место рядом и дойдите кнопками «Предыдущий интервал» и «Следующий интервал». На краях кнопка шага недоступна, без выделения недоступны все три.">
          <LineChart title="Средний чек по неделям, EUR" series={weeks} interval="week" zeroBaseline formatX={(x) => `неделя с ${dayName.format(date(x))}`}
            formatTick={(x) => dayTick.format(date(x))} formatValue={formatAxis} valueAxisLabel="EUR" />
        </Example>
        <Example title="Линейный: все серии скрыты" note="Кнопки шага остаются недоступными и ничего не закрывают.">
          <LineChart title="Цена за штуку, EUR (серии скрыты)" series={prices.slice(0, 2)} interval="month" defaultHiddenKeys={['s1', 's2']}
            formatX={(x) => monthName.format(date(x))} formatTick={(x) => monthTick.format(date(x))} formatValue={formatAxis} />
        </Example>
        <Example title="Линейный: нет данных" note="Панели кнопок нет.">
          <LineChart title="Цена" series={[]} formatX={(x) => x} formatValue={formatAxis} emptyMessage="Покупок за выбранный период нет." />
        </Example>
        <div className="spending-currency">
          <Example title="Круговая: траты по категориям"
            note="Пальцем: касание сектора или строки таблицы закрепляет подсветку и показывает сумму в центре, повторное касание либо касание вне диаграммы снимает; сектор по касанию не уводит со страницы — переход по ссылке в таблице. Мышью сектор по-прежнему ссылка.">
            <PieChart title="Траты по категориям, EUR" items={categories} centerLabel="Сумма строк" centerValue={formatAmount(total.toFixed(2), 'EUR')}
              headers={{ name: 'Категория', value: 'Сумма', share: 'Доля' }} />
          </Example>
        </div>
      </main>
    </div>
  )
}

function Example({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="health-panel" style={{ marginBottom: 24, display: 'grid', gap: 14 }}>
      <h2>{title}</h2>
      {note && <p className="intro-note" style={{ margin: 0, maxWidth: 'none' }}>{note}</p>}
      {children}
    </section>
  )
}
