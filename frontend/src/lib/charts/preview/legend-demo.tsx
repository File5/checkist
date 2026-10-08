/* Synthetic data for the standalone preview of the legend rows of an item's parts (pie-legend-preview/index.html).
   Nothing here is used by the application; names and sums are invented, the «requests» are local state. */
import { useMemo, useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import { formatAmount, formatPercent } from '../../format.ts'
import { PieChart } from '../index.ts'
import type { ChartLinkProps, PieChartChild, PieChartItem } from '../index.ts'

type Tail = 'loaded' | 'rest' | 'long' | 'loading' | 'failed'
const tails: { key: Tail; label: string }[] = [
  { key: 'loaded', label: 'Состав загружен' },
  { key: 'rest', label: 'Остаток и примечание о долях' },
  { key: 'long', label: '500 строк' },
  { key: 'loading', label: 'Загрузка' },
  { key: 'failed', label: 'Отказ с повтором' },
]

const total = 2500
const eur = (cents: number) => formatAmount((cents / 100).toFixed(2), 'EUR')
const share = (cents: number) => formatPercent(((cents / 100 / total) * 100).toFixed(2))
const top: [string, number][] = [
  ['Demo молоко и сливки', 52000], ['Demo хлеб и выпечка', 41000], ['Demo сыр', 33000], ['Demo овощи', 27000], ['Demo фрукты', 21000],
  ['Demo кофе и чай', 17000], ['Demo макароны и крупы', 13000], ['Demo йогурты', 11000], ['Demo яйца', 9000], ['Demo масло', 8000],
]
const otherCents = 15000
const tailNames = ['Demo соль и специи с очень длинным названием для проверки переноса строки', 'Demo мука', 'Demo сахар', 'Demo уксус']
const tailCents = [6000, 4500, 3000, 1500]

function children(tail: Tail): PieChartChild[] {
  if (tail === 'long') {
    return Array.from({ length: 500 }, (_, index) => ({
      key: `p${index}`, label: `Demo товар №${index + 1}`, href: `#product-${index + 1}`, valueText: eur(30), shareText: share(30), note: '1 строка · 1 чек',
    }))
  }
  const rows: PieChartChild[] = tailNames.map((label, index) => ({
    key: `g${index}`, label, href: `#generic-${index + 11}`, valueText: eur(tailCents[index]), shareText: share(tailCents[index]),
    note: `${index + 2} строки · ${index + 1} чек${index === 0 ? '' : 'а'}`,
  }))
  if (tail !== 'rest') return rows
  return [...rows.slice(0, 2), {
    key: 'rest', label: 'Ещё 37 товаров с меньшими суммами, одной строкой', valueText: eur(4500), shareText: share(4500),
    note: 'Чтобы увидеть их, сузьте период или откройте обобщённый продукт.',
  }]
}

export default function LegendDemo() {
  const [open, setOpen] = useState(false)
  const [tail, setTail] = useState<Tail>('loaded')
  const [light, setLight] = useState(false)
  const rows = useMemo(() => children(tail), [tail])

  // Stands in for the project `Link`: the toggle changes local state instead of the address.
  const Link = useMemo(() => function DemoLink({ to, ...props }: ChartLinkProps) {
    const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault()
      if (to === '#open' || to === '#closed') setOpen(to === '#open')
    }
    return <a {...props} href={to} onClick={onClick} />
  }, [])

  const status: ReactNode = !open ? undefined
    : tail === 'loading' ? <p className="spending-status" role="status">Загружаем состав…</p>
      : tail === 'failed' ? (
        <div role="status" style={{ display: 'grid', gap: 8, justifyItems: 'start' }}>
          <p>Не удалось загрузить состав: сервер не ответил.</p>
          <button type="button" onClick={() => setTail('loaded')}>Повторить</button>
        </div>
      ) : tail === 'rest' ? (
        <p className="ck-chart-note">В «Прочем» есть строки с неположительной суммой: доли состава посчитаны от суммы положительных строк полного списка.</p>
      ) : undefined
  const shown = open && tail !== 'loading' && tail !== 'failed'

  const items: PieChartItem[] = [
    ...top.map(([label, cents], index): PieChartItem => ({ key: `g${index}`, label, value: cents / 100, valueText: eur(cents), shareText: share(cents), href: `#generic-${index + 1}` })),
    {
      key: 'other', label: 'Прочее', value: otherCents / 100, valueText: eur(otherCents), shareText: share(otherCents), tone: 'other',
      note: open ? '4 обобщённых продукта с меньшими суммами.' : 'Ещё 4 обобщённых продукта с меньшими суммами, одной строкой.',
      action: {
        label: open ? 'Скрыть состав' : 'Показать состав', ariaLabel: `${open ? 'Скрыть' : 'Показать'} состав «Прочего», EUR`,
        href: open ? '#closed' : '#open', expanded: open,
      },
      children: shown ? rows : undefined, childrenPrefix: 'В составе «Прочего»: ', childrenStatus: status,
    },
    { key: 'unmatched', label: 'Строки без товара', value: 20, valueText: eur(2000), shareText: share(2000), tone: 'muted', note: 'Товар для строки чека не определён.' },
    { key: 'deposit', label: 'Залог за тару', value: -3, valueText: eur(-300), shareText: '—', tone: 'muted' },
  ]

  const toggleTheme = () => {
    const next = !light
    setLight(next)
    if (next) document.documentElement.setAttribute('data-theme', 'light')
    else document.documentElement.removeAttribute('data-theme')
  }

  return (
    <div className="page">
      <main>
        <div className="intro">
          <p className="eyebrow">Ф1 · предпросмотр компонента</p>
          <h1>Состав «Прочего» в легенде круговой диаграммы</h1>
          <p className="intro-note">
            Настоящий компонент PieChart на вымышленных данных. Это не экран приложения: запросов к серверу нет, ссылка «Показать
            состав» меняет состояние страницы, а не адрес; состояние загрузки и отказа выбирается ниже. Экран /stats подключает
            это в следующей подзадаче.
          </p>
        </div>
        <section className="health-panel" style={{ marginBottom: 24, display: 'grid', gap: 14 }}>
          <h2>Что показать под «Прочим»</h2>
          <fieldset style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 18px', margin: 0, padding: 0, border: 0 }}>
            <legend className="ck-chart-note">Состояние состава после нажатия «Показать состав»</legend>
            {tails.map((option) => (
              <label key={option.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minHeight: 44 }}>
                <input type="radio" name="tail" style={{ width: 18, height: 18, minHeight: 0, margin: 0 }} checked={tail === option.key} onChange={() => setTail(option.key)} />
                {option.label}
              </label>
            ))}
          </fieldset>
          <p><button type="button" onClick={toggleTheme}>{light ? 'Тёмная тема' : 'Светлая тема'}</button></p>
        </section>
        <section className="health-panel spending-currency" style={{ marginBottom: 24 }}>
          <PieChart title="Траты по обобщённым продуктам, EUR" items={items} centerLabel="Сумма строк" centerValue={eur(total * 100)}
            headers={{ name: 'Обобщённый продукт', value: 'Сумма', share: 'Доля' }} linkComponent={Link} />
        </section>
      </main>
    </div>
  )
}
