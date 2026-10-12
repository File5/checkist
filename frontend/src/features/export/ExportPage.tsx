import { useEffect, useId, useMemo, useState } from 'react'
import { getCategories } from '../../api/catalog'
import { getStores } from '../../api/stores'
import type { Category, StoreEntry } from '../../api/types'
import Sheet from '../../components/Sheet'
import { navigate } from '../../navigation'
import { formatPurchasedOn } from '../../lib/format'
import { personName } from '../../lib/people'
import type { Person } from '../../lib/people'
import { exportDocumentUrl, getExportPreview } from './export-api'
import type { ExportPreview } from './export-api'
import {
  deviceToday, exportHref, periodLabels, periodRange, periods, sectionLabels, sections, sourceLabels, sources, toggled, defaultSections,
} from './export-query'
import type { ExportQuery, Period } from './export-query'
import { categoryOptions, matchingCategories, previewText, tooLarge } from './export-state'
import type { CategoryOption } from './export-state'
import './Export.css'

export type PreviewState = { kind: 'loading' } | { kind: 'error' } | { kind: 'ok'; data: ExportPreview }

export interface ExportViewProps {
  query: ExportQuery
  today: string
  preview: PreviewState
  /** The family, from the last answer: it stays while a newer count is on its way. */
  people: Person[]
  categories: CategoryOption[]
  /** Names of the stores of the selection, by id; an unknown one is shown by its number. */
  storeNames: Map<number, string>
  storeSearch: string
  storeResults: StoreEntry[]
  categoriesOpen: boolean
  storesOpen: boolean
  categorySearch: string
  onChange: (query: ExportQuery) => void
  onStoreSearch: (text: string) => void
  onRememberStore: (store: StoreEntry) => void
  onCategoriesOpen: (open: boolean) => void
  onStoresOpen: (open: boolean) => void
  onCategorySearch: (text: string) => void
}

function Chip({ pressed, onClick, children, label }: { pressed: boolean; onClick: () => void; children: string; label?: string }) {
  return <button type="button" className="ck-chip" aria-pressed={pressed} aria-label={label} onClick={onClick}>{children}</button>
}

function Removable({ label, onRemove }: { label: string; onRemove: () => void }) {
  return <button type="button" className="ck-chip export-removable" aria-label={`Убрать: ${label}`} onClick={onRemove}>
    <span>{label}</span><span aria-hidden="true" className="export-removable-mark">×</span>
  </button>
}

const chevron = <svg className="export-chevron" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 6l6 6-6 6" /></svg>
const downloadIcon = <svg className="export-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19h14" /></svg>

/** The value of a row of choices: «Все», the one chosen, or how many. */
const chosenText = (names: string[]) => names.length === 0 ? 'Все' : names.length === 1 ? names[0] : `Выбрано: ${names.length}`

export function ExportView(props: ExportViewProps) {
  const { query, today, preview, people, categories, storeNames, storeSearch, storeResults, categoriesOpen, storesOpen, categorySearch, onChange } = props
  const ids = useId()
  const period: Period = query.period ?? 'this-month'
  const range = periodRange(query, today)
  const chosenSections = query.sections ?? [...defaultSections]
  const byId = new Map(categories.map((option) => [option.id, option]))
  const currencies = [...new Set([...(query.currency ? [query.currency] : []), 'KZT', 'RUB', 'EUR',
    ...(preview.kind === 'ok' ? preview.data.summary.currencies.map((block) => block.currency) : [])])].sort()
  const large = preview.kind === 'ok' && tooLarge(preview.data)
  const set = (patch: Partial<ExportQuery>) => onChange({ ...query, ...patch })
  const listed = (values: unknown[] | undefined) => values && values.length ? values : undefined
  const categoryName = (id: number) => byId.get(id)?.path ?? `Категория №${id}`
  const storeName = (id: number) => storeNames.get(id) ?? `Магазин №${id}`
  const chosenStores = query.store?.length ? <div className="export-chips export-chosen" role="group" aria-label="Выбранные магазины">
    {query.store.map((id) => <Removable key={id} label={storeName(id)}
      onRemove={() => set({ store: listed(toggled(query.store, id)) as number[] | undefined })} />)}
  </div> : null

  return (
    <div className="export">
      <p className="export-intro">Все чеки и траты семьи одним файлом JSON: суммы точные, до копейки. Фильтры сохраняются в адресе — набор можно добавить в закладки.</p>

      <section className="export-block" aria-labelledby={`${ids}-period`}>
        <h2 id={`${ids}-period`} className="export-heading">Период</h2>
        <div className="export-chips" role="group" aria-label="Период">
          {periods.map((value) => <Chip key={value} pressed={value === period}
            onClick={() => set({ period: value === 'this-month' ? undefined : value, ...(value !== 'custom' && { from: undefined, to: undefined }) })}>{periodLabels[value]}</Chip>)}
        </div>
        {period === 'custom'
          ? <div className="export-dates">
            <label className="export-field">С
              <input type="date" value={query.from ?? ''} max={query.to} onChange={(event) => set({ from: event.target.value || undefined })} />
            </label>
            <label className="export-field">По
              <input type="date" value={query.to ?? ''} min={query.from} onChange={(event) => set({ to: event.target.value || undefined })} />
            </label>
          </div>
          : <p className="export-note">{range.from && range.to ? <><time dateTime={range.from}>{formatPurchasedOn(range.from)}</time>{'\u00a0— '}<time dateTime={range.to}>{formatPurchasedOn(range.to)}</time></> : 'Без ограничения по датам'}</p>}
      </section>

      <section className="export-block export-list" aria-label="Что попадёт в файл">
        <ul className="export-rows">
          <li>
            <button type="button" className="export-row" aria-haspopup="dialog" aria-expanded={categoriesOpen} onClick={() => props.onCategoriesOpen(true)}>
              <span className="export-row-label" id={`${ids}-categories`}>Категории</span>
              <span className="export-row-value">{chosenText((query.category ?? []).map(categoryName))}</span>
              {chevron}
            </button>
            {query.category?.length
              ? <div className="export-chips export-chosen" role="group" aria-label="Выбранные категории">
                {query.category.map((id) => <Removable key={id} label={categoryName(id)}
                  onRemove={() => set({ category: listed(toggled(query.category, id)) as number[] | undefined })} />)}
              </div>
              : <p className="export-row-note">Подкатегории входят в выбранную.</p>}
          </li>
          <li>
            <button type="button" className="export-row" aria-haspopup="dialog" aria-expanded={storesOpen} onClick={() => props.onStoresOpen(true)}>
              <span className="export-row-label" id={`${ids}-stores`}>Магазины</span>
              <span className="export-row-value">{chosenText((query.store ?? []).map(storeName))}</span>
              {chevron}
            </button>
            {chosenStores}
          </li>
          <li>
            <label className="export-row">
              <span className="export-row-label">Валюта</span>
              <select value={query.currency ?? ''} onChange={(event) => set({ currency: event.target.value || undefined })}>
                <option value="">Все валюты</option>
                {currencies.map((code) => <option key={code} value={code}>{code}</option>)}
              </select>
              {chevron}
            </label>
          </li>
        </ul>
      </section>

      <Sheet open={categoriesOpen} onClose={() => props.onCategoriesOpen(false)} title="Категории" closeLabel="Готово">
        <label className="export-field">Поиск
          <input type="search" value={categorySearch} placeholder="Например, молочное" onChange={(event) => props.onCategorySearch(event.target.value)} />
        </label>
        <ul className="export-tree" aria-label="Дерево категорий">
          {matchingCategories(categories, categorySearch).map((option) => (
            <li key={option.id} style={{ paddingInlineStart: `${categorySearch.trim() ? 0 : option.depth * 20}px` }}>
              <label className="export-check">
                <input type="checkbox" checked={query.category?.includes(option.id) ?? false}
                  onChange={() => set({ category: listed(toggled(query.category, option.id)) as number[] | undefined })} />
                <span>{categorySearch.trim() ? option.path : option.name}</span>
              </label>
            </li>
          ))}
        </ul>
      </Sheet>

      <Sheet open={storesOpen} onClose={() => props.onStoresOpen(false)} title="Магазины" closeLabel="Готово">
        <div className="export-sheet">
          {chosenStores}
          <label className="export-field">Найти магазин
            <input type="search" value={storeSearch} placeholder="Название магазина" onChange={(event) => props.onStoreSearch(event.target.value)} />
          </label>
          {storeResults.length > 0 ? <ul className="export-results" aria-label="Найденные магазины">
            {storeResults.map((store) => {
              const chosen = query.store?.includes(store.id) ?? false
              return <li key={store.id}>
                <button type="button" className="export-result" aria-pressed={chosen} onClick={() => {
                  props.onRememberStore(store)
                  set({ store: listed(toggled(query.store, store.id)) as number[] | undefined })
                }}>
                  <span className="export-result-name">{store.name}</span>
                  {store.city && <span className="export-result-city">{store.city}</span>}
                </button>
              </li>
            })}
          </ul> : <p className="export-note">{storeSearch.trim().length < 2 ? 'Наберите хотя бы две буквы названия.' : 'Ничего не нашлось.'}</p>}
        </div>
      </Sheet>

      <section className="export-block" aria-labelledby={`${ids}-source`}>
        <h2 id={`${ids}-source`} className="export-heading">Откуда</h2>
        <div className="export-chips" role="group" aria-label="Откуда">
          {sources.map((value) => <Chip key={value} pressed={query.source?.includes(value) ?? false}
            onClick={() => set({ source: listed(toggled(query.source, value)) as ExportQuery['source'] })}>{sourceLabels[value]}</Chip>)}
        </div>
        <p className="export-note">Ничего не выбрано — всё. «Выписки» — ручные траты из банковской выписки.</p>
      </section>

      {people.length > 1 && <section className="export-block" aria-labelledby={`${ids}-people`}>
        <h2 id={`${ids}-people`} className="export-heading">Кто добавил</h2>
        <div className="export-chips" role="group" aria-label="Кто добавил">
          {people.map((person) => <Chip key={person.username} pressed={query.owner?.includes(person.username) ?? false}
            onClick={() => set({ owner: listed(toggled(query.owner, person.username)) as string[] | undefined })}>{personName(person.username, person.display_name)}</Chip>)}
        </div>
      </section>}

      <fieldset className="export-block export-sections">
        <legend className="export-heading">Что выгрузить</legend>
        <p className="export-note">Чеки и траты выгружаются всегда.</p>
        <div className="export-checks">
          {sections.map((value) => <label key={value} className="export-check">
            <input type="checkbox" checked={chosenSections.includes(value)}
              onChange={() => set({ sections: sections.filter((item) => item === value ? !chosenSections.includes(item) : chosenSections.includes(item)) })} />
            <span>{sectionLabels[value]}</span>
          </label>)}
        </div>
      </fieldset>

      <div className="export-actions ck-action-bar">
        <p className="export-preview" aria-live="polite">
          {preview.kind === 'loading' && 'Считаем…'}
          {preview.kind === 'error' && 'Не удалось посчитать. Выгрузка всё равно доступна.'}
          {preview.kind === 'ok' && previewText(preview.data).map((part, index) => part.figure
            ? <span key={index} className="ck-figures">{part.text}</span> : <span key={index}>{part.text}</span>)}
        </p>
        {large && <p className="export-warning" role="alert">Слишком много чеков для одного файла: сузьте период или добавьте фильтры.</p>}
        <div className="export-buttons">
          {large
            ? <button type="button" className="export-download" disabled>Скачать JSON</button>
            : <a className="export-download" href={exportDocumentUrl(query, today, true)} download>{downloadIcon}Скачать JSON</a>}
          {!large && <a className="export-show" href={exportDocumentUrl(query, today, false)} target="_blank" rel="noopener">Открыть</a>}
        </div>
      </div>
    </div>
  )
}

const searchDelay = 300

export default function ExportPage({ query }: { query: ExportQuery }) {
  const today = useMemo(() => deviceToday(), [])
  // The answer is kept with the address it belongs to: a newer address shows «Считаем…» until its own answer.
  const [answer, setAnswer] = useState<{ key: string; state: PreviewState } | undefined>(undefined)
  const [categories, setCategories] = useState<CategoryOption[]>([])
  const [categoriesOpen, setCategoriesOpen] = useState(false)
  const [storesOpen, setStoresOpen] = useState(false)
  const [categorySearch, setCategorySearch] = useState('')
  const [storeSearch, setStoreSearch] = useState('')
  const [storeResults, setStoreResults] = useState<StoreEntry[]>([])
  const [remembered, setRemembered] = useState<Map<number, string>>(new Map())
  const key = exportHref(query)
  const [people, setPeople] = useState<Person[]>([])

  useEffect(() => {
    const controller = new AbortController()
    void getCategories({}, { signal: controller.signal }).then((result) => {
      if (result.kind === 'ok') setCategories(categoryOptions(result.data.results as Category[]))
    })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void getExportPreview(query, today, { signal: controller.signal }).then((result) => {
        if (result.kind === 'ok') {
          setAnswer({ key, state: { kind: 'ok', data: result.data } })
          setPeople(result.data.people)
        }
        else if (result.kind === 'error') setAnswer({ key, state: { kind: 'error' } })
      })
    }, searchDelay)
    return () => { clearTimeout(timer); controller.abort() }
    // The address holds the whole query: it changes exactly when the query does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, today])

  useEffect(() => {
    const text = storeSearch.trim()
    if (text.length < 2) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void getStores({ q: text, page_size: 10 }, { signal: controller.signal }).then((result) => {
        if (result.kind === 'ok') setStoreResults(result.data.results)
      })
    }, searchDelay)
    return () => { clearTimeout(timer); controller.abort() }
  }, [storeSearch])

  const preview: PreviewState = answer?.key === key ? answer.state : { kind: 'loading' }
  const shownStores = storeSearch.trim().length < 2 ? [] : storeResults
  const storeNames = new Map(remembered)
  if (preview.kind === 'ok') for (const store of preview.data.stores) storeNames.set(store.id, store.name)

  return <ExportView query={query} today={today} preview={preview} people={people} categories={categories} storeNames={storeNames}
    storeSearch={storeSearch} storeResults={shownStores} categoriesOpen={categoriesOpen} storesOpen={storesOpen} categorySearch={categorySearch}
    onChange={(next) => navigate(exportHref(next), { replace: true })}
    onStoreSearch={setStoreSearch}
    onRememberStore={(store) => setRemembered((current) => new Map(current).set(store.id, store.name))}
    onCategoriesOpen={setCategoriesOpen} onStoresOpen={setStoresOpen} onCategorySearch={setCategorySearch} />
}
