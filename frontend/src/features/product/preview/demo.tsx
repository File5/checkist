/* Standalone preview of the «График цен» block (price-chart-preview/index.html): the real PriceChartView on the
   backend's fixture answers that build.mjs passes in. There is no server here, so only the price switch of the
   first example changes the data; nothing here is used by the application. */
import { useState } from 'react'
import type { PriceSeries } from '../../../api/price-series.ts'
import type { ProductQuery } from '../../../navigation/index.ts'
import { PriceChartView } from '../PriceChart.tsx'
import type { HiddenSeries } from '../PriceChart.tsx'
import type { RequestState } from '../state.ts'
import '../Product.css'

const fixtures = (globalThis as { __PRICE_SERIES_FIXTURES__?: Record<string, PriceSeries> }).__PRICE_SERIES_FIXTURES__ ?? {}
const noop = () => {}

function Example({ title, note, state, query, similar = true, onPrice = noop }: {
  title: string; note: string; state: RequestState<PriceSeries>; query: ProductQuery; similar?: boolean
  onPrice?: (price: 'paid' | 'normalized') => void
}) {
  const [hidden, setHidden] = useState<HiddenSeries>({})
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <h2 style={{ margin: '12px 0 0' }}>{title}</h2>
      <p className="product-note" style={{ margin: 0 }}>{note}</p>
      <PriceChartView state={state} query={query} similar={similar} hidden={hidden} onPrice={onPrice} onInterval={noop} onSimilar={noop}
        onHidden={(panel, keys) => setHidden((previous) => ({ ...previous, [panel]: keys }))} retry={noop} reset={noop} />
    </div>
  )
}

const ok = (name: string): RequestState<PriceSeries> => ({ kind: 'ok', data: fixtures[`price-series-${name}.json`] })

export default function PriceChartDemo() {
  const [price, setPrice] = useState<'paid' | 'normalized'>('paid')
  return (
    <div className="page">
      <main className="product-page" style={{ maxWidth: 920, margin: '0 auto', padding: '24px 16px' }}>
        <h1>График цен в карточке товара — превью (Ф6)</h1>
        <p className="product-note">Настоящий компонент блока на эталонных ответах сервера (backend/api/tests/fixtures/stats/price-series-*.json).
          Сервера здесь нет: данные меняет только переключатель «Цена» в первом примере; «Интервал», «Показывать похожие товары»,
          «Повторить» и «Сбросить фильтры» в превью ничего не делают. Легенда, наведение, клавиатура и таблица значений работают.
          Это не приёмка экрана в приложении.</p>
        <Example title="1. Молоко: свой магазин и похожие товары в DE и KZ" query={{ page: 1, date_from: '2025-01-01', ...(price === 'normalized' && { price }) }}
          note="Переключите «Цена»: за единицу в чеке — предупреждение о фасовках; за кг / л / шт — цена за литр, сопоставимо."
          state={ok(price === 'paid' ? 'milk-paid' : 'milk-normalized')} onPrice={setPrice} />
        <Example title="2. Яблоки, цена за кг: два своих магазина на одной панели" query={{ page: 1, date_from: '2026-01-01', price: 'normalized' }}
          note="Похожий товар из KZ — на отдельной панели KZT." state={ok('apples-normalized')} />
        <Example title="3. Товар в «Не разобрано»" query={{ page: 1, date_from: '2026-01-01' }}
          note="similar.status = generic_unassigned." state={ok('unassigned')} />
        <Example title="4. Похожие выключены, интервал — неделя" query={{ page: 1, date_from: '2026-09-01', interval: 'week' }} similar={false}
          note="similar.status = disabled; одна серия — легенды нет." state={ok('similar-none')} />
        <Example title="5. Нет наблюдений за период" query={{ page: 1, date_to: '2018-12-31' }}
          note="series: [], similar.status = none." state={ok('empty')} />
        <Example title="6. Загрузка" query={{ page: 1 }} note="Переключатели остаются доступными." state={{ kind: 'loading' }} />
        <Example title="7. Ошибка сети" query={{ page: 1 }} note="Локальный повтор; таблица истории и сводка от графика не зависят."
          state={{ kind: 'error', reason: 'network' }} />
        <Example title="8. Слишком много точек (range_too_large)" query={{ page: 1, interval: 'day' }}
          note="Предлагается интервал крупнее." state={{ kind: 'error', reason: 'range_too_large', status: 400 }} />
      </main>
    </div>
  )
}
