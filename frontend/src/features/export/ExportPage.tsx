import { useEffect, useId, useMemo, useState } from 'react'
import { getCategories } from '../../api/catalog'
import { getStores } from '../../api/stores'
import type { Category, StoreEntry } from '../../api/types'
import ChipScroller from '../../components/ChipScroller'
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
  categorySearch: string
  onChange: (query: ExportQuery) => void
  onStoreSearch: (text: string) => void
  onRememberStore: (store: StoreEntry) => void
  onCategoriesOpen: (open: boolean) => void
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

export function ExportView(props: ExportViewProps) {
  const { query, today, preview, people, categories, storeNames, storeSearch, storeResults, categoriesOpen, categorySearch, onChange } = props
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

  return (
    <div className="export">
      <p className="export-intro">Все чеки и траты семьи одним файлом JSON: суммы точные, до копейки. Фильтры сохраняются в адресе — набор можно добавить в закладки.</p>

      <section className="export-block" aria-labelledby={`${ids}-period`}>
        <h2 id={`${ids}-period`} className="export-heading">Период</h2>
        <ChipScroller label="Период">
          {periods.map((value) => <Chip key={value} pressed={value === period}
            onClick={() => set({ period: value === 'this-month' ? undefined : value, ...(value !== 'custom' && { from: undefined, to: undefined }) })}>{periodLabels[value]}</Chip>)}
        </ChipScroller>
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

      <section className="export-block" aria-labelledby={`${ids}-categories`}>
        <h2 id={`${ids}-categories`} className="export-heading">Категории</h2>
        {query.category?.length
          ? <ChipScroller label="Выбранные категории">
            {query.category.map((id) => <Removable key={id} label={byId.get(id)?.path ?? `Категория №${id}`}
              onRemove={() => set({ category: listed(toggled(query.category, id)) as number[] | undefined })} />)}
          </ChipScroller>
          : <p className="export-note">Все категории. Подкатегории входят в выбранную.</p>}
        <button type="button" className="ck-button-secondary export-open" aria-haspopup="dialog" aria-expanded={categoriesOpen}
          onClick={() => props.onCategoriesOpen(true)}>Выбрать категории</button>
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
      </section>

      <section className="export-block" aria-labelledby={`${ids}-source`}>
        <h2 id={`${ids}-source`} className="export-heading">Откуда</h2>
        <ChipScroller label="Откуда">
          {sources.map((value) => <Chip key={value} pressed={query.source?.includes(value) ?? false}
            onClick={() => set({ source: listed(toggled(query.source, value)) as ExportQuery['source'] })}>{sourceLabels[value]}</Chip>)}
        </ChipScroller>
        <p className="export-note">Ничего не выбрано — всё. «Выписки» — ручные траты из банковской выписки.</p>
      </section>

      {people.length > 1 && <section className="export-block" aria-labelledby={`${ids}-people`}>
        <h2 id={`${ids}-people`} className="export-heading">Кто добавил</h2>
        <ChipScroller label="Кто добавил">
          {people.map((person) => <Chip key={person.username} pressed={query.owner?.includes(person.username) ?? false}
            onClick={() => set({ owner: listed(toggled(query.owner, person.username)) as string[] | undefined })}>{personName(person.username, person.display_name)}</Chip>)}
        </ChipScroller>
      </section>}

      <section className="export-block" aria-labelledby={`${ids}-stores`}>
        <h2 id={`${ids}-stores`} className="export-heading">Магазины</h2>
        {query.store?.length ? <ChipScroller label="Выбранные магазины">
          {query.store.map((id) => <Removable key={id} label={storeNames.get(id) ?? `Магазин №${id}`}
            onRemove={() => set({ store: listed(toggled(query.store, id)) as number[] | undefined })} />)}
        </ChipScroller> : null}
        <label className="export-field">Найти магазин
          <input type="search" value={storeSearch} placeholder="Название магазина" onChange={(event) => props.onStoreSearch(event.target.value)} />
        </label>
        {storeResults.length > 0 && <ul className="export-results" aria-label="Найденные магазины">
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
        </ul>}
      </section>

      <section className="export-block" aria-labelledby={`${ids}-currency`}>
        <h2 id={`${ids}-currency`} className="export-heading">Валюта</h2>
        <label className="export-field">Валюта чеков
          <select value={query.currency ?? ''} onChange={(event) => set({ currency: event.target.value || undefined })}>
            <option value="">Все валюты</option>
            {currencies.map((code) => <option key={code} value={code}>{code}</option>)}
          </select>
        </label>
      </section>

      <fieldset className="export-block export-sections">
        <legend className="export-heading">Что выгрузить</legend>
        <p className="export-note">Чеки и траты выгружаются всегда.</p>
        {sections.map((value) => <label key={value} className="export-check">
          <input type="checkbox" checked={chosenSections.includes(value)}
            onChange={() => set({ sections: sections.filter((item) => item === value ? !chosenSections.includes(item) : chosenSections.includes(item)) })} />
          <span>{sectionLabels[value]}</span>
        </label>)}
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
            : <a className="export-download" href={exportDocumentUrl(query, today, true)} download>Скачать JSON</a>}
          {!large && <a className="action-link export-show" href={exportDocumentUrl(query, today, false)} target="_blank" rel="noopener">Открыть</a>}
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
    storeSearch={storeSearch} storeResults={shownStores} categoriesOpen={categoriesOpen} categorySearch={categorySearch}
    onChange={(next) => navigate(exportHref(next), { replace: true })}
    onStoreSearch={setStoreSearch}
    onRememberStore={(store) => setRemembered((current) => new Map(current).set(store.id, store.name))}
    onCategoriesOpen={setCategoriesOpen} onCategorySearch={setCategorySearch} />
}
