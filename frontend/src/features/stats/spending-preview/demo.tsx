/* Standalone preview of the spending screen (frontend/spending-preview/index.html): the real components on the
   backend's example answers. Nothing here is used by the application; links and buttons do not navigate. */
import type { MouseEvent, ReactNode } from 'react'
import type { CountryEntry } from '../../../api/countries.ts'
import type { Spending } from '../../../api/stats.ts'
import type { Page, StoreEntry } from '../../../api/types.ts'
import type { SpendingQuery } from '../../../navigation/routes.ts'
import type { SpendingReference } from '../spending-filters.tsx'
import SpendingFilters from '../spending-filters.tsx'
import SpendingResults from '../spending-results.tsx'
import type { Shown, SpendingRequestState } from '../spending-state.ts'

export type DemoFixtures = Record<'category' | 'drilldown' | 'product' | 'store' | 'refund' | 'empty', Spending>

const noop = () => {}
const countries: CountryEntry[] = [
  { code: 'DE', name: 'Германия', currencies: ['EUR'], stores_count: 2, products_count: 30 },
  { code: 'KZ', name: 'Казахстан', currencies: ['KZT'], stores_count: 1, products_count: 9 },
]
const store = (id: number, name: string, city: string, country: string, address: string): StoreEntry =>
  ({ id, name, city, country, address, timezone: 'UTC', receipts_count: 1 })
const stores: Page<StoreEntry> = { count: 3, page: 1, page_size: 200, pages: 1, results: [
  store(1, 'Zahlenfrisch', 'Musterstadt', 'DE', 'Beispielweg 1'), store(2, 'Beispielkorb', 'Beispielhausen', 'DE', 'Musterallee 7'),
  store(3, 'Статмаркет', 'Алматы', 'KZ', 'ул. Примерная, 5'),
] }
const reference: SpendingReference = { countries: { kind: 'ok', data: { results: countries } }, stores: { kind: 'ok', data: stores }, retry: noop }
const today = '2026-10-07'

/** The page is not the application: a link or a button must not leave it. Checkboxes and inputs stay editable. */
function inert(event: MouseEvent<HTMLElement>) {
  if (!(event.target instanceof Element)) return
  if (event.target.closest('a')) event.preventDefault()
  if (event.target.closest('button')) event.stopPropagation()
}

function Case({ title, note, query, state, last, genericName, filters }: {
  title: string; note: ReactNode; query: SpendingQuery; state: SpendingRequestState; last?: Shown; genericName?: string; filters?: boolean
}) {
  return <section className="spending-preview-case">
    <h2 className="spending-preview-title">{title}</h2>
    <p className="spending-preview-note">{note}</p>
    <div className="spending-page">
      {filters && <SpendingFilters query={query} failure={state.kind === 'error' ? state : undefined} reference={reference} today={today} />}
      <SpendingResults query={query} state={state} retry={noop} last={last} genericName={genericName} />
    </div>
  </section>
}

export default function SpendingDemo({ fixtures }: { fixtures: DemoFixtures }) {
  const ok = (data: Spending): SpendingRequestState => ({ kind: 'ok', data })
  return <div className="page spending-preview" onClickCapture={inert}
    onSubmitCapture={(event) => { event.preventDefault(); event.stopPropagation() }}>
    <header className="spending-preview-head">
      <h1>Траты за период — предпросмотр</h1>
      <p>Это не работающее приложение, а снимок настоящих компонентов экрана <code>/stats</code> на эталонных ответах сервера
        (<code>backend/api/tests/fixtures/stats/spending-*.json</code>, демо-данные вымышлены). Ссылки и кнопки здесь никуда не ведут;
        наведение на сектор и строку таблицы работает, если страница выполняет скрипт. Снимок не заменяет приёмку экрана в браузере.</p>
    </header>
    <Case title="1. Категории, две валюты" filters query={{}} state={ok(fixtures.category)}
      note="Ответ spending-category.json: отдельный блок на валюту, «Не разобрано», строки без товара, услуги и залог." />
    <Case title="2. Внутри категории" query={{ category: 1 }} state={ok(fixtures.drilldown)}
      note="Ответ spending-category-drilldown.json: «хлебные крошки», «На уровень выше», товары без подкатегории; сумма чеков под фильтром категории не показывается." />
    <Case title="3. Товары и «Прочее», период" filters query={{ date_from: '2026-01-01', date_to: '2026-09-30', group_by: 'product' }} state={ok(fixtures.product)}
      note="Ответ spending-product.json: строка товара ведёт в карточку товара, остальные товары свёрнуты в «Прочее»." />
    <Case title="4. Магазины" query={{ group_by: 'store' }} state={ok(fixtures.store)}
      note="Ответ spending-store.json: значение магазина — сумма его чеков." />
    <Case title="5. Сумма не положительная" query={{ date_from: '2026-03-14', date_to: '2026-03-14' }} state={ok(fixtures.refund)}
      note="Ответ spending-refund-day.json (день с одним возвратом): строка остаётся в таблице с пометкой, диаграмма не строится." />
    <Case title="6. Первая загрузка" query={{}} state={{ kind: 'loading' }} note="Место под результат зарезервировано." />
    <Case title="7. Смена фильтров: прежний ответ на месте" query={{ group_by: 'store' }} state={{ kind: 'loading' }} last={{ query: {}, data: fixtures.category }}
      note="Пока грузится ответ по новым фильтрам, прежний остаётся на экране приглушённым — страница не прыгает." />
    <Case title="8. Чеков нет вообще" query={{}} state={ok({ ...fixtures.empty, date_from: null, date_to: null })} note="Пустая база, фильтров нет." />
    <Case title="9. Нет данных по фильтрам" query={{ date_from: '2018-01-01', date_to: '2018-12-31' }} state={ok(fixtures.empty)}
      note="Ответ spending-empty.json: есть сброс фильтров." />
    <Case title="10. Ошибка сети" query={{}} state={{ kind: 'error', reason: 'network' }} note="Повтор только по кнопке." />
    <Case title="11. Локальный режим выключен" query={{}} state={{ kind: 'error', reason: 'permission_denied', status: 403 }}
      note="403 permission_denied: без кнопки повтора и без автоматических попыток." />
    <Case title="12. Сервер не принял фильтры" filters query={{ country: 'ZZ', store: [404] }}
      state={{ kind: 'error', reason: 'invalid_parameter', status: 400, fields: ['country', 'store'] }}
      note="400 invalid_parameter с полями country и store: поля подсвечены, текст сервера не показывается." />
  </div>
}
