/* Standalone preview of the composition of «Прочее» on the spending screen (frontend/spending-tail-preview/index.html):
   the real result block of `/stats` on the backend's example answers. Nothing here is used by the application:
   there are no requests, the toggle link changes local state instead of the address, the other links do nothing. */
import { useMemo, useState } from 'react'
import type { MouseEvent } from 'react'
import type { Spending, SpendingCurrency } from '../../../api/stats.ts'
import type { SpendingQuery } from '../../../navigation/routes.ts'
import SpendingResults from '../spending-results.tsx'
import type { SpendingRequestState } from '../spending-state.ts'
import { cents, shortBlock } from '../spending-tail-test-support.ts'

export type TailFixtures = Record<'product' | 'generic' | 'store', Spending>

type Mode = 'loaded' | 'loading' | 'network' | 'denied' | 'changed' | 'shares'
const modes: { key: Mode; label: string }[] = [
  { key: 'loaded', label: 'Состав пришёл' },
  { key: 'loading', label: 'Загрузка' },
  { key: 'network', label: 'Нет связи (с повтором)' },
  { key: 'denied', label: 'Отказ без повтора' },
  { key: 'changed', label: 'Данные изменились' },
  { key: 'shares', label: 'Другая база долей' },
]
type Data = keyof TailFixtures
const sets: { key: Data; label: string; keep: number; query: SpendingQuery; note: string }[] = [
  { key: 'product', label: 'Товары, EUR и KZT', keep: 1, query: { date_from: '2026-01-01', date_to: '2026-09-30', group_by: 'product' },
    note: 'spending-product.json (limit=3): в составе два товара и остаток «ещё N товаров» — как при списке длиннее лимита.' },
  { key: 'generic', label: 'Обобщённые продукты, EUR', keep: 2, query: { currency: 'EUR', group_by: 'generic' },
    note: 'spending-generic.json (limit=5): в составе три обобщённых продукта и остаток; строки состава — ссылки на свой уровень.' },
  { key: 'store', label: 'Магазины', keep: 1, query: { group_by: 'store' },
    note: 'spending-store.json: в EUR состав без остатка (весь список поместился); в блоке KZT один магазин — «Прочего» и ссылки нет.' },
]

/** Share of the roll-up as the server counts it: of the positive parts of the block, two places, half up. Exact integers. */
function otherShare(block: SpendingCurrency): string | null {
  if (!block.other) return null
  const parts = [...block.items.map((item) => cents(item.amount)), cents(block.other.amount)]
  const base = parts.reduce((total, part) => (part > 0n ? total + part : total), 0n)
  const amount = cents(block.other.amount)
  if (amount <= 0n || base === 0n) return null
  const hundredths = (amount * 100_000n / base + 5n) / 10n
  const digits = hundredths.toString().padStart(3, '0')
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`
}
/** The usual answer the server would give next to the example (the long one): the examples hold no such pair. */
function usual(long: Spending, keep: number): Spending {
  return { ...long, currencies: long.currencies.map((block) => {
    const short = shortBlock(block, keep)
    return short.other ? { ...short, other: { ...short.other, share_percent: otherShare(short) } } : short
  }) }
}

function tailState(mode: Mode, long: Spending): SpendingRequestState {
  switch (mode) {
    case 'loading': return { kind: 'loading' }
    case 'network': return { kind: 'error', reason: 'network' }
    case 'denied': return { kind: 'error', reason: 'permission_denied', status: 403 }
    // The long answer of another moment: its sum of lines is not the one of the block on screen.
    case 'changed': return { kind: 'ok', data: { ...long, currencies: long.currencies.map((block) => ({ ...block, totals: { ...block.totals, lines_paid: '0.01' } })) } }
    // Only a share of the long answer that is never shown is altered: every number on screen stays the example's.
    case 'shares': return { kind: 'ok', data: { ...long, currencies: long.currencies.map((block) => ({ ...block,
      items: block.items.map((item, index) => index === 0 ? { ...item, share_percent: '0.01' } : item) })) } }
    default: return { kind: 'ok', data: long }
  }
}

const radio = { width: 18, height: 18, minHeight: 0, margin: 0 }
const option = { display: 'inline-flex', alignItems: 'center', gap: 8, minHeight: 44 }
const options = { display: 'flex', flexWrap: 'wrap', gap: '4px 18px', margin: 0, padding: 0, border: 0 } as const

export default function SpendingTailDemo({ fixtures }: { fixtures: TailFixtures }) {
  const [data, setData] = useState<Data>('product')
  const [mode, setMode] = useState<Mode>('loaded')
  const [open, setOpen] = useState(true)
  const [light, setLight] = useState(false)
  const set = sets.find((entry) => entry.key === data) ?? sets[0]
  const long = fixtures[data]
  const state = useMemo((): SpendingRequestState => ({ kind: 'ok', data: usual(long, set.keep) }), [long, set])
  const tail = useMemo(() => tailState(mode, long), [mode, long])
  const query = useMemo((): SpendingQuery => ({ ...set.query, ...(open && { other: 'open' as const }) }), [set, open])

  /** The page is not the application: the toggle link changes the state of the page, no link leaves it. */
  const click = (event: MouseEvent<HTMLElement>) => {
    if (!(event.target instanceof Element)) return
    const link = event.target.closest('a')
    if (!link) return
    event.preventDefault()
    if (link.classList.contains('ck-pie-action')) setOpen(link.getAttribute('aria-expanded') !== 'true')
  }
  const toggleTheme = () => {
    const next = !light
    setLight(next)
    if (next) document.documentElement.setAttribute('data-theme', 'light')
    else document.documentElement.removeAttribute('data-theme')
  }
  const loaded = () => setMode('loaded')

  return <div className="page">
    <main>
      <div className="intro">
        <p className="eyebrow">Ф2 · предпросмотр, не приёмка</p>
        <h1>Раскрытие «Прочего» на экране трат</h1>
        <p className="intro-note">
          Настоящий блок результатов экрана <code>/stats</code> на эталонных ответах сервера (демо-данные вымышлены). Запросов
          здесь нет: ссылка «Показать состав» / «Скрыть состав» меняет состояние страницы, а не адрес; что «ответил» второй
          запрос, выбирается ниже; остальные ссылки никуда не ведут. Эталон играет роль длинного ответа (<code>limit=500</code>),
          обычный ответ собран из него: первые строки и «Прочее» с суммой остальных — в примерах сервера такой пары нет.
        </p>
      </div>
      <section className="health-panel spending-tail-preview-controls">
        <h2>Что показать</h2>
        <fieldset style={options}>
          <legend className="spending-note">Разбивка (эталонный ответ)</legend>
          {sets.map((entry) => <label key={entry.key} style={option}>
            <input type="radio" name="data" style={radio} checked={data === entry.key} onChange={() => setData(entry.key)} />{entry.label}
          </label>)}
        </fieldset>
        <p className="spending-note">{set.note}</p>
        <fieldset style={options}>
          <legend className="spending-note">Ответ запроса состава</legend>
          {modes.map((entry) => <label key={entry.key} style={option}>
            <input type="radio" name="mode" style={radio} checked={mode === entry.key} onChange={() => setMode(entry.key)} />{entry.label}
          </label>)}
        </fieldset>
        <p><button type="button" onClick={toggleTheme}>{light ? 'Тёмная тема' : 'Светлая тема'}</button></p>
      </section>
      <div className="spending-page" onClickCapture={click}>
        <SpendingResults query={query} state={state} retry={loaded} tail={tail} retryTail={loaded} />
      </div>
    </main>
  </div>
}
