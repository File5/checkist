import { useId, useReducer, useRef } from 'react'
import type { CountryEntry } from '../../api/countries'
import type { Page, Results, StoreEntry } from '../../api/types'
import { Link, navigate, spendingHref } from '../../navigation'
import type { SpendingQuery } from '../../navigation'
import { maxStatsStores } from '../../navigation/routes'
import { storeLabel } from '../product/state'
import type { RequestState } from '../product/state'
import {
  activePreset, applyFilters, filterDraft, formReducer, hasScopeFilters, initForm, presetHref, presetLabels, presets,
  requestKey, resetFiltersHref, sameDraft, serverFieldErrors,
} from './spending-state'
import type { FilterField, SpendingFailure, TextField } from './spending-state'

/** Reference lists for the selects; the filters stay usable without them. */
export type SpendingReference = {
  countries: RequestState<Results<CountryEntry>>
  stores: RequestState<Page<StoreEntry>>
  retry: () => void
}

const sorted = (values: Iterable<string>) => [...new Set(values)].sort()

export default function SpendingFilters({ query, failure, reference, today }: {
  query: SpendingQuery; failure?: SpendingFailure; reference: SpendingReference; today: string
}) {
  // Without `other`: showing or hiding the composition of «Прочее» keeps the unsaved edits of the form.
  const source = requestKey(query)
  const [state, dispatch] = useReducer(formReducer, query, initForm)
  if (state.source !== source) dispatch({ type: 'sync', query })
  const form = state.source === source ? state : initForm(query)
  const { draft } = form
  const applied = filterDraft(query)
  const errors = { ...serverFieldErrors(failure, draft, applied), ...form.errors }
  const formRef = useRef<HTMLFormElement>(null)
  const id = useId()

  const countries = reference.countries.kind === 'ok' ? reference.countries.data.results : []
  const stores = reference.stores.kind === 'ok' ? reference.stores.data.results : []
  const referenceFailed = reference.countries.kind === 'error' || reference.stores.kind === 'error'
  const referenceLoading = reference.countries.kind === 'loading' || reference.stores.kind === 'loading'
  const country = countries.find((entry) => entry.code === draft.country)
  const countryCodes = sorted([...countries.map((entry) => entry.code), ...(draft.country ? [draft.country] : [])])
  const currencies = sorted([...(country ?? { currencies: countries.flatMap((entry) => entry.currencies) }).currencies,
    ...(draft.currency ? [draft.currency] : [])])
  // Selected stores stay listed whatever the country, and an id unknown to the reference is still removable.
  const listed = stores.filter((store) => !draft.country || store.country === draft.country || draft.store.includes(store.id))
  const unknown = draft.store.filter((storeId) => !stores.some((store) => store.id === storeId))
  const truncated = reference.stores.kind === 'ok' && reference.stores.data.count > stores.length
  const full = draft.store.length >= maxStatsStores

  const describe = (field: FilterField, ...more: string[]) => [...more, errors[field] && `${id}-${field}-error`].filter(Boolean).join(' ') || undefined
  const error = (field: FilterField) => errors[field] && <p className="spending-field-error" id={`${id}-${field}-error`}>{errors[field]}</p>
  const set = (field: TextField, value: string) => dispatch({ type: 'set', field, value })
  const focusField = (field: string) => {
    const found = formRef.current?.elements.namedItem(field)
    const target = found instanceof RadioNodeList ? found[0] : found
    if (target instanceof HTMLElement) target.focus()
  }
  const dateInput = (field: 'date_from' | 'date_to', label: string) => <div className="spending-field">
    <label htmlFor={`${id}-${field}`}>{label}</label>
    <input id={`${id}-${field}`} name={field} type="date" value={draft[field]} onChange={(event) => set(field, event.target.value)}
      aria-invalid={Boolean(errors[field])} aria-describedby={describe(field, `${id}-period-help`)} />
    {error(field)}
  </div>
  const select = (field: 'country' | 'currency', label: string, all: string, options: [string, string][]) => <div className="spending-field">
    <label htmlFor={`${id}-${field}`}>{label}</label>
    <select id={`${id}-${field}`} name={field} value={draft[field]} onChange={(event) => set(field, event.target.value)}
      aria-invalid={Boolean(errors[field])} aria-describedby={describe(field)}>
      <option value="">{all}</option>
      {options.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
    </select>
    {error(field)}
  </div>
  const active = activePreset(query, today)

  return <section className="spending-panel" aria-labelledby={`${id}-heading`}>
    <h2 id={`${id}-heading`}>Период и фильтры</h2>
    <nav aria-label="Быстрый выбор периода">
      <ul className="spending-chips">
        {presets.map((preset) => <li key={preset}>
          <Link to={presetHref(query, preset, today)} aria-current={active === preset ? 'true' : undefined}>{presetLabels[preset]}</Link>
        </li>)}
      </ul>
    </nav>
    <form ref={formRef} noValidate onSubmit={(event) => {
      event.preventDefault()
      const result = applyFilters(query, draft)
      dispatch({ type: 'invalid', errors: result.errors })
      const invalid = Object.keys(result.errors)[0]
      if (invalid) focusField(invalid)
      else navigate(spendingHref(result.query))
    }}>
      <div className="spending-grid">{dateInput('date_from', 'Период с')}{dateInput('date_to', 'Период по')}</div>
      <p className="spending-note" id={`${id}-period-help`}>Обе даты включительно, по дате покупки в магазине. Без дат — вся история.</p>
      <div className="spending-grid">
        {select('country', 'Страна магазина', 'Все страны', countryCodes.map((code) => {
          const name = countries.find((entry) => entry.code === code)?.name
          return [code, name ? `${name} (${code})` : code]
        }))}
        {select('currency', 'Валюта чека', 'Все валюты', currencies.map((code) => [code, code]))}
      </div>
      <fieldset className="spending-stores" aria-describedby={describe('store', `${id}-store-help`)}>
        <legend>Магазины</legend>
        <p className="spending-note" id={`${id}-store-help`}>
          {draft.store.length ? `Выбрано: ${draft.store.length} из ${maxStatsStores} возможных.` : `Все магазины. Можно выбрать до ${maxStatsStores}.`}
          {truncated && ` Показаны первые ${stores.length} магазинов справочника.`}
        </p>
        {listed.length + unknown.length > 0 && <ul className="spending-store-list">
          {unknown.map((storeId) => <li key={storeId}><label>
            <input type="checkbox" name="store" value={storeId} checked onChange={() => dispatch({ type: 'toggle-store', id: storeId })} />
            <span>ID {storeId} · нет в загруженном справочнике</span>
          </label></li>)}
          {listed.map((store) => {
            const checked = draft.store.includes(store.id)
            return <li key={store.id}><label>
              <input type="checkbox" name="store" value={store.id} checked={checked} disabled={!checked && full}
                onChange={() => dispatch({ type: 'toggle-store', id: store.id })} />
              <span>{storeLabel(store)}</span>
            </label></li>
          })}
        </ul>}
        {reference.stores.kind === 'ok' && listed.length + unknown.length === 0 && <p className="spending-note">
          {draft.country ? 'В выбранной стране магазинов нет.' : 'Магазинов пока нет.'}
        </p>}
        {draft.store.length > 0 && <button type="button" className="spending-secondary" onClick={() => {
          dispatch({ type: 'clear-stores' })
          focusField('country')
        }}>Убрать все магазины</button>}
        {error('store')}
      </fieldset>
      {referenceLoading && !referenceFailed && <p className="spending-note" role="status">Загружаем списки стран и магазинов…</p>}
      {referenceFailed && <div className="spending-reference-error" role="status">
        <p>Списки стран и магазинов не загрузились. Период и уже выбранные значения можно применить и без них.</p>
        <button type="button" className="spending-secondary" onClick={reference.retry}>Повторить загрузку списков</button>
      </div>}
      {Object.keys(errors).length > 0 && <p className="spending-field-error" role="alert">Исправьте отмеченные фильтры.</p>}
      <div className="spending-actions">
        <button type="submit">Применить фильтры</button>
        {(hasScopeFilters(query) || !sameDraft(draft, applied)) && <button type="button" className="spending-secondary" onClick={() => {
          dispatch({ type: 'reset' })
          navigate(resetFiltersHref(query))
          focusField('date_from')
        }}>Сбросить фильтры</button>}
      </div>
    </form>
  </section>
}
