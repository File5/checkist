import { useCallback, useId, useMemo, useRef, useState } from 'react'
import type { FormEvent, Ref } from 'react'
import { getCountries } from '../../api/countries'
import type { CountryEntry } from '../../api/countries'
import { getStores } from '../../api/stores'
import type { StoreEntry } from '../../api/types'
import { useLocalRequestFocus } from '../../components/useLocalRequestFocus'
import { buildReceiptsStatsQuery, Link, maxStatsStores, navigate } from '../../navigation'
import type { ReceiptsStatsQuery } from '../../navigation'
import { useProductRequest } from '../product/useProductRequest'
import {
  applyFilters, filterDraft, formErrors, hasPeriods, hasScope, isActivePreset, localToday, periodPresets, presetHref, sameDraft,
} from './receipts-state'
import type { DateField, FilterDraft, FilterErrors, FilterField } from './receipts-state'

/** A reference list of the form; the form stays usable while it loads or after it failed. */
export type Reference<T> = { kind: 'loading' } | { kind: 'error' } | { kind: 'ok'; items: T[]; total: number }
const phaseOf = (reference: { kind: 'loading' | 'error' | 'ok' }) => reference.kind

export interface ReceiptsFiltersFormProps {
  query: ReceiptsStatsQuery
  draft: FilterDraft
  errors: FilterErrors
  /** Browser's calendar date, for the ready pairs of periods. */
  today: string
  countries: Reference<CountryEntry>
  stores: Reference<StoreEntry>
  onChange: (field: Exclude<FilterField, 'store'>, value: string) => void
  onToggleStore: (id: number) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onReset: () => void
  onRetryCountries: () => void
  onRetryStores: () => void
  formRef?: Ref<HTMLFormElement>
}

function storeLabel(store: StoreEntry): string {
  return [store.name.trim() || `Магазин ID ${store.id}`, store.address.trim() || store.city.trim(), store.country].filter(Boolean).join(' · ')
}

function ScopeSelects({ id, draft, errors, countries, onChange, onRetry }: {
  id: string; draft: FilterDraft; errors: FilterErrors; countries: Reference<CountryEntry>
  onChange: ReceiptsFiltersFormProps['onChange']; onRetry: () => void
}) {
  const phase = useMemo(() => ({ kind: phaseOf(countries) }), [countries])
  const block = useLocalRequestFocus<HTMLDivElement>(phase)
  const known = countries.kind === 'ok' ? countries.items : []
  const chosen = known.find((country) => country.code === draft.country)
  // Currencies of saved receipts: of the chosen country, or of every country.
  const currencies = [...new Set((chosen ? [chosen] : known).flatMap((country) => country.currencies))].sort()
  const select = (field: 'country' | 'currency', label: string, all: string, options: [string, string][]) => (
    <div className="stats-field">
      <label htmlFor={`${id}-${field}`}>{label}</label>
      <select id={`${id}-${field}`} name={field} value={draft[field]} onChange={(event) => onChange(field, event.target.value)}
        aria-invalid={Boolean(errors[field])} aria-describedby={errors[field] ? `${id}-${field}-error` : undefined}>
        <option value="">{all}</option>
        {draft[field] && !options.some(([value]) => value === draft[field]) && <option value={draft[field]}>{draft[field]}</option>}
        {options.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
      </select>
      {errors[field] && <p className="stats-field-error" id={`${id}-${field}-error`}>{errors[field]}</p>}
    </div>
  )
  return (
    <div ref={block} className="stats-scope" aria-busy={countries.kind === 'loading'} data-request-focus-target tabIndex={-1}>
      <div className="stats-field-grid">
        {select('country', 'Страна магазина', 'Все страны', known.map((country) => [country.code, `${country.name} (${country.code})`]))}
        {select('currency', 'Валюта чека', 'Все валюты', currencies.map((currency) => [currency, currency]))}
      </div>
      {countries.kind === 'loading' && <p className="stats-note" role="status">Загружаем список стран и валют…</p>}
      {countries.kind === 'error' && <div className="stats-reference-error">
        <p className="stats-field-error" role="status">Не удалось загрузить список стран и валют. Уже выбранные значения сохраняются, сравнение и график работают.</p>
        <button type="button" className="stats-secondary" data-request-retry onClick={onRetry}>Повторить</button>
      </div>}
    </div>
  )
}

function StoresField({ id, draft, error, stores, onToggle, onRetry }: {
  id: string; draft: FilterDraft; error?: string; stores: Reference<StoreEntry>; onToggle: (id: number) => void; onRetry: () => void
}) {
  const phase = useMemo(() => ({ kind: phaseOf(stores) }), [stores])
  const block = useLocalRequestFocus<HTMLFieldSetElement>(phase)
  const listed = stores.kind === 'ok' ? stores.items : []
  // A store of the address stays selectable even when the list does not hold it.
  const unlisted = draft.store.filter((storeId) => !listed.some((store) => store.id === storeId))
  const checkbox = (storeId: number, label: string) => (
    <li key={storeId}>
      <label className="stats-check">
        <input type="checkbox" name="store" value={storeId} checked={draft.store.includes(storeId)} onChange={() => onToggle(storeId)}
          aria-invalid={Boolean(error)} aria-describedby={`${id}-store-note${error ? ` ${id}-store-error` : ''}`} />
        <span>{label}</span>
      </label>
    </li>
  )
  return (
    <fieldset ref={block} className="stats-stores" aria-busy={stores.kind === 'loading'}>
      <legend data-request-focus-target tabIndex={-1}>Магазины</legend>
      <p className="stats-note" id={`${id}-store-note`}>
        Без отметок учитываются все магазины. Выбрано: {draft.store.length.toLocaleString('ru-RU')} из не более {maxStatsStores}.
      </p>
      {(listed.length > 0 || unlisted.length > 0) && <ul className="stats-store-list">
        {unlisted.map((storeId) => checkbox(storeId, `Магазин ID ${storeId} (нет в показанном списке)`))}
        {listed.map((store) => checkbox(store.id, storeLabel(store)))}
      </ul>}
      {error && <p className="stats-field-error" id={`${id}-store-error`}>{error}</p>}
      {stores.kind === 'loading' && <p className="stats-note" role="status">Загружаем список магазинов…</p>}
      {stores.kind === 'ok' && listed.length === 0 && <p className="stats-note" role="status">
        {draft.country ? 'В выбранной стране магазинов нет.' : 'Магазинов пока нет: они появляются вместе с первыми чеками.'}
      </p>}
      {stores.kind === 'ok' && stores.total > listed.length && <p className="stats-note">
        Показаны первые {listed.length.toLocaleString('ru-RU')} магазинов из {stores.total.toLocaleString('ru-RU')}. Выберите страну, чтобы сузить список.
      </p>}
      {stores.kind === 'error' && <div className="stats-reference-error">
        <p className="stats-field-error" role="status">Не удалось загрузить список магазинов. Уже выбранные магазины сохраняются, остальные фильтры работают.</p>
        <button type="button" className="stats-secondary" data-request-retry onClick={onRetry}>Повторить</button>
      </div>}
    </fieldset>
  )
}

/** The form itself: no requests and no navigation, so it can be rendered with any state. */
export function ReceiptsFiltersForm({
  query, draft, errors, today, countries, stores, onChange, onToggleStore, onSubmit, onReset, onRetryCountries, onRetryStores, formRef,
}: ReceiptsFiltersFormProps) {
  const id = useId()
  const presets = periodPresets(today)
  const date = (field: DateField, label: string) => (
    <div className="stats-field">
      <label htmlFor={`${id}-${field}`}>{label}</label>
      <input id={`${id}-${field}`} name={field} type="date" value={draft[field]} onChange={(event) => onChange(field, event.target.value)}
        aria-invalid={Boolean(errors[field])} aria-describedby={`${id}-period-note${errors[field] ? ` ${id}-${field}-error` : ''}`} />
      {errors[field] && <p className="stats-field-error" id={`${id}-${field}-error`}>{errors[field]}</p>}
    </div>
  )
  const changed = !sameDraft(draft, filterDraft(query))
  return (
    <section className="stats-panel" aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`}>Периоды и фильтры</h3>
      {presets.length > 0 && <nav className="stats-presets" aria-label="Готовые пары периодов">
        <span className="stats-presets-title">Быстрый выбор:</span>
        <ul>
          {presets.map((preset) => (
            <li key={preset.key}>
              <Link className="stats-chip" to={presetHref(query, preset)} aria-current={isActivePreset(query, preset) ? 'true' : undefined}>{preset.label}</Link>
            </li>
          ))}
        </ul>
      </nav>}
      <form ref={formRef} noValidate onSubmit={onSubmit}>
        <div className="stats-periods">
          <fieldset className="stats-period">
            <legend>Базовый период (было)</legend>
            <div className="stats-field-grid">{date('base_from', 'С')}{date('base_to', 'По')}</div>
          </fieldset>
          <fieldset className="stats-period">
            <legend>Текущий период (стало)</legend>
            <div className="stats-field-grid">{date('current_from', 'С')}{date('current_to', 'По')}</div>
          </fieldset>
        </div>
        <p className="stats-note" id={`${id}-period-note`}>
          Обе границы включительно, по дате покупки в магазине. Периоды не должны пересекаться: текущий начинается позже окончания базового.
        </p>
        <ScopeSelects id={id} draft={draft} errors={errors} countries={countries} onChange={onChange} onRetry={onRetryCountries} />
        <StoresField id={id} draft={draft} error={errors.store} stores={stores} onToggle={onToggleStore} onRetry={onRetryStores} />
        {Object.keys(errors).length > 0 && <p className="stats-field-error" role="alert">Исправьте отмеченные поля.</p>}
        <div className="stats-actions">
          <button type="submit">Сравнить периоды</button>
          {(hasPeriods(query) || hasScope(query) || changed) && <button type="button" className="stats-secondary" onClick={onReset}>Сбросить периоды и фильтры</button>}
        </div>
      </form>
    </section>
  )
}

/** Owns the draft and the two reference lists; the applied state lives in the address. */
export default function ReceiptsFilters({ query, applied }: { query: ReceiptsStatsQuery; /** Problems of the applied address. */ applied: FilterErrors }) {
  const source = buildReceiptsStatsQuery(query)
  const [form, setForm] = useState({ source, draft: filterDraft(query), errors: {} as FilterErrors })
  if (form.source !== source) setForm({ source, draft: filterDraft(query), errors: {} })
  const draft = form.source === source ? form.draft : filterDraft(query)
  const [today] = useState(() => localToday())
  const formRef = useRef<HTMLFormElement>(null)

  const loadCountries = useCallback((signal: AbortSignal) => getCountries({}, { signal }), [])
  const countries = useProductRequest(loadCountries)
  const country = draft.country
  const loadStores = useCallback((signal: AbortSignal) => getStores({ ...(country && { country }), page_size: 50 }, { signal }), [country])
  const stores = useProductRequest(loadStores)
  const countryList = useMemo((): Reference<CountryEntry> => (countries.state.kind === 'ok'
    ? { kind: 'ok', items: countries.state.data.results, total: countries.state.data.results.length } : { kind: countries.state.kind }), [countries.state])
  const storeList = useMemo((): Reference<StoreEntry> => (stores.state.kind === 'ok'
    ? { kind: 'ok', items: stores.state.data.results, total: stores.state.data.count } : { kind: stores.state.kind }), [stores.state])

  const focusField = (field: string) => {
    const control = formRef.current?.querySelector<HTMLElement>(`[name="${field}"]`)
    control?.focus()
  }
  return (
    <ReceiptsFiltersForm
      formRef={formRef} query={query} draft={draft} today={today} countries={countryList} stores={storeList}
      errors={formErrors(draft, filterDraft(query), form.errors, applied)}
      onChange={(field, value) => setForm({ source, draft: { ...draft, [field]: value }, errors: {} })}
      onToggleStore={(storeId) => setForm({
        source, errors: {},
        draft: { ...draft, store: draft.store.includes(storeId) ? draft.store.filter((item) => item !== storeId) : [...draft.store, storeId].sort((a, b) => a - b) },
      })}
      onSubmit={(event) => {
        event.preventDefault()
        const result = applyFilters(query, draft)
        setForm({ source, draft, errors: result.errors })
        const field = Object.keys(result.errors)[0]
        if (field) focusField(field)
        else navigate({ kind: 'receipts-stats', query: result.query })
      }}
      onReset={() => {
        setForm({ source, draft: filterDraft({}), errors: {} })
        navigate({ kind: 'receipts-stats', query: query.interval ? { interval: query.interval } : {} })
        focusField('base_from')
      }}
      onRetryCountries={countries.retry} onRetryStores={stores.retry}
    />
  )
}
