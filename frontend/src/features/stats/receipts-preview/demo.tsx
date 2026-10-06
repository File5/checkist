/* Standalone preview of the average receipt screen (receipts-stats-preview/index.html) for the human reviewer.
   The real components of the screen on the backend's reference answers (demo data of seed_stats_demo); no request
   is made. Scenarios marked «изменённый эталон» alter a few numbers of a reference answer to show another sign. */
import compareMainJson from '../../../../../backend/api/tests/fixtures/stats/compare-2020-2026.json'
import compareEmptyJson from '../../../../../backend/api/tests/fixtures/stats/compare-empty.json'
import compareNoMatchedJson from '../../../../../backend/api/tests/fixtures/stats/compare-no-matched-products.json'
import compareOneSidedJson from '../../../../../backend/api/tests/fixtures/stats/compare-one-sided.json'
import seriesMonthJson from '../../../../../backend/api/tests/fixtures/stats/series-month.json'
import seriesYearJson from '../../../../../backend/api/tests/fixtures/stats/series-year.json'
import type { CountryEntry } from '../../../api/countries.ts'
import { isReceiptCompare, isReceiptSeries } from '../../../api/stats-schema.ts'
import type { ReceiptCompare, ReceiptSeries } from '../../../api/stats.ts'
import type { StoreEntry } from '../../../api/types.ts'
import type { ReceiptsStatsQuery } from '../../../navigation/index.ts'
import CompareBlock from '../receipts-compare.tsx'
import { ReceiptsFiltersForm } from '../receipts-filters.tsx'
import { appliedErrors, comparePlan, filterDraft } from '../receipts-state.ts'
import type { CompareState, SeriesState, StatsFailure } from '../receipts-state.ts'
import TrendBlock from '../receipts-trend.tsx'

function compare(body: unknown): ReceiptCompare {
  if (!isReceiptCompare(body)) throw new Error('A reference answer of the comparison does not match the runtime schema.')
  return structuredClone(body)
}
function series(body: unknown): ReceiptSeries {
  if (!isReceiptSeries(body)) throw new Error('A reference answer of the series does not match the runtime schema.')
  return body
}
const noop = () => {}
const loaded = (data: ReceiptCompare): CompareState => ({ kind: 'ok', data })
const chart = (data: ReceiptSeries): SeriesState => ({ kind: 'ok', data })
const failure = (reason: StatsFailure['reason']): StatsFailure => ({ kind: 'error', reason })

const periods: ReceiptsStatsQuery = { base_from: '2020-01-01', base_to: '2020-12-31', current_from: '2026-01-01', current_to: '2026-09-30' }
// Reference lists of the demo database: countries, currencies and shops of the reference answers.
const countries: CountryEntry[] = [
  { code: 'DE', name: 'Германия', currencies: ['EUR'], stores_count: 2, products_count: 0 },
  { code: 'KZ', name: 'Казахстан', currencies: ['KZT'], stores_count: 1, products_count: 0 },
]
const stores: StoreEntry[] = [
  { id: 1, name: 'Zahlenfrisch', city: 'Musterstadt', country: 'DE', address: '', timezone: 'Europe/Berlin', receipts_count: 0 },
  { id: 2, name: 'Beispielkorb', city: 'Beispielhausen', country: 'DE', address: '', timezone: 'Europe/Berlin', receipts_count: 0 },
  { id: 3, name: 'Статмаркет', city: 'Алматы', country: 'KZ', address: '', timezone: 'Asia/Almaty', receipts_count: 0 },
]

const lower = compare(compareMainJson)
lower.currencies = lower.currencies.slice(0, 1)
Object.assign(lower.currencies[0], {
  base: { ...lower.currencies[0].current },
  current: { ...lower.currencies[0].current, avg_receipt: '39.22', median_receipt: '38.90', lines_per_receipt: '12.10', paid_per_line: '3.2413' },
  change: { avg_receipt: '-6.50', avg_receipt_percent: '-14.22' },
  effects: { quantity: '-8.17', price: '2.07', mix: '-0.40', price_per_line: '1.67', quantity_percent: '125.69', price_percent: '-31.85', mix_percent: '6.15' },
  price_index: { ...lower.currencies[0].price_index!, fisher: '1.0551', laspeyres: '1.0560', paasche: '1.0542' },
})
const lowCoverage = compare(compareMainJson)
lowCoverage.currencies = lowCoverage.currencies.slice(0, 1)
Object.assign(lowCoverage.currencies[0].price_index!, { coverage_current_percent: '31.20' })

function Scenario({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section className="preview-scenario" style={{ display: 'grid', gap: 14, marginBottom: 40 }}>
      <h2>{title}</h2>
      <p className="intro-note" style={{ margin: 0, maxWidth: 'none' }}>{note}</p>
      <div className="stats-receipts">{children}</div>
    </section>
  )
}
function Form({ query }: { query: ReceiptsStatsQuery }) {
  return <ReceiptsFiltersForm query={query} draft={filterDraft(query)} errors={appliedErrors(query, [])} today="2026-10-07"
    countries={{ kind: 'ok', items: countries, total: countries.length }} stores={{ kind: 'ok', items: stores, total: stores.length }}
    onChange={noop} onToggleStore={noop} onSubmit={(event) => event.preventDefault()} onReset={noop} onRetryCountries={noop} onRetryStores={noop} />
}

export default function ReceiptsStatsDemo() {
  const overlap: ReceiptsStatsQuery = { base_from: '2020-01-01', base_to: '2026-01-01', current_from: '2026-01-01', current_to: '2026-09-30' }
  const overlapPlan = comparePlan(overlap)
  const yearly: ReceiptsStatsQuery = { ...periods, interval: 'year' }
  return (
    <div className="page">
      <main>
        <div className="intro" style={{ maxWidth: 'none' }}>
          <p className="eyebrow">Ф5 · предпросмотр экрана</p>
          <h1>Средний чек</h1>
          <p className="intro-note" style={{ maxWidth: 'none' }}>
            Настоящие компоненты экрана /stats/receipts на эталонных ответах сервера (демо-данные seed_stats_demo). Это не приложение:
            запросов нет, поля, кнопки формы и ссылки ничего не меняют. Графики интерактивны: наведение, фокус, ← → Home End Esc, флажки серий.
            Поведение экрана с настоящим сервером проверяется вручную по шагам из описания.
          </p>
        </div>
        <Scenario title="1. Главный вопрос: 2020 против января — сентября 2026"
          note="Эталоны compare-2020-2026.json и series-year.json: две валюты, три слагаемых, индекс цен, совпавшие товары, график по годам.">
          <Form query={yearly} />
          <CompareBlock state={loaded(compare(compareMainJson))} query={yearly} onRetry={noop} />
          <TrendBlock state={chart(series(seriesYearJson))} query={yearly} onRetry={noop} />
        </Scenario>
        <Scenario title="2. График по месяцам" note="Эталон series-month.json: EUR, январь — сентябрь 2026.">
          <TrendBlock state={chart(series(seriesMonthJson))} query={{ current_from: '2026-01-01', current_to: '2026-09-30', currency: 'EUR' }} onRetry={noop} />
        </Scenario>
        <Scenario title="3. Нет товаров, купленных в обоих периодах"
          note="Эталон compare-no-matched-products.json: вместо «цен» и «состава» — общая «цена позиции» с объяснением.">
          <CompareBlock state={loaded(compare(compareNoMatchedJson))} onRetry={noop}
            query={{ base_from: '2020-01-04', base_to: '2020-01-04', current_from: '2026-02-18', current_to: '2026-02-18', currency: 'EUR' }} />
        </Scenario>
        <Scenario title="4. Походы только в одном периоде" note="Эталон compare-one-sided.json: сравнивать не с чем, разложения нет.">
          <CompareBlock state={loaded(compare(compareOneSidedJson))} onRetry={noop}
            query={{ base_from: '2018-01-01', base_to: '2018-12-31', current_from: '2026-09-01', current_to: '2026-09-30', currency: 'KZT' }} />
        </Scenario>
        <Scenario title="5. Чек снизился, одно слагаемое действует против"
          note="Изменённый эталон: числа изменения, слагаемых и индекса подставлены вручную, чтобы показать знаки, штриховку и левую часть полосы.">
          <CompareBlock state={loaded(lower)} query={periods} onRetry={noop} />
        </Scenario>
        <Scenario title="6. Низкое покрытие индекса цен" note="Изменённый эталон: покрытие текущего периода заменено на 31,2 % — заметное предупреждение.">
          <CompareBlock state={loaded(lowCoverage)} query={periods} onRetry={noop} />
        </Scenario>
        <Scenario title="7. Периоды не выбраны"
          note="Первое открытие /stats/receipts: сравнение ждёт периодов, график показывает все чеки (здесь — его состояние загрузки).">
          <Form query={{}} />
          <CompareBlock state={{ kind: 'idle' }} query={{}} onRetry={noop} />
          <TrendBlock state={{ kind: 'loading' }} query={{}} onRetry={noop} />
        </Scenario>
        <Scenario title="8. Периоды пересекаются" note="Адрес с base_to = current_from: поле подсвечено, запрос сравнения не отправляется.">
          <Form query={overlap} />
          <CompareBlock state={overlapPlan.kind === 'invalid' ? overlapPlan : { kind: 'idle' }} query={overlap} onRetry={noop} />
        </Scenario>
        <Scenario title="9. Пусто по фильтрам" note="Эталон compare-empty.json, в адресе есть фильтр валюты.">
          <CompareBlock state={loaded(compare(compareEmptyJson))} query={{ ...periods, currency: 'EUR' }} onRetry={noop} />
        </Scenario>
        <Scenario title="10. Отказы" note="Локальный режим выключен (403), сеть недоступна, слишком много интервалов (400 range_too_large).">
          <CompareBlock state={failure('permission_denied')} query={periods} onRetry={noop} />
          <CompareBlock state={failure('network')} query={periods} onRetry={noop} />
          <TrendBlock state={failure('range_too_large')} query={{ ...periods, interval: 'week' }} onRetry={noop} />
        </Scenario>
      </main>
    </div>
  )
}
