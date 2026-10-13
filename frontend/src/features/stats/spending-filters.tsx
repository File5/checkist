import { useId, useReducer, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { CountryEntry } from '../../api/countries'
import type { Page, Results, StoreEntry } from '../../api/types'
import ChipScroller from '../../components/ChipScroller'
import ResponsiveFilters from '../../components/ResponsiveFilters'
import { useNarrow } from '../../lib/cards'
import { Link, navigate, spendingHref } from '../../navigation'
import type { SpendingQuery } from '../../navigation'
import { maxStatsStores } from '../../navigation/routes'
import { storeLabel } from '../product/state'
import { useChipInView } from './chip-in-view'
import type { RequestState } from '../product/state'
import { DateRange, PeriodDate } from './period'
import {
  activePreset, applyFilters, filterCount, filterDraft, filterMessages, formReducer, initForm, presetHref, presetLabels, presets,
  requestKey, sameDraft, serverFieldErrors,
} from './spending-state'
import type { FilterErrors, FilterField, SpendingFailure, TextField } from './spending-state'
import { PeriodSheet } from './stats-period'

/** Reference lists for the selects; the filters stay usable without them. */
export type SpendingReference = {
  countries: RequestState<Results<CountryEntry>>
  stores: RequestState<Page<StoreEntry>>
  retry: () => void
}

const sorted = (values: Iterable<string>) => [...new Set(values)].sort()

/** «С» and «По» of the period sheet: the other filters, the breakdown and the place in the drill-down stay. */
function SpendingPeriodForm({ query, onDone }: { query: SpendingQuery; onDone: () => void }) {
  const id = useId()
  const [dates, setDates] = useState({ date_from: query.date_from ?? '', date_to: query.date_to ?? '' })
  const [errors, setErrors] = useState<FilterErrors>({})
  const field = (name: 'date_from' | 'date_to', label: string) => <div className="spending-field">
    <label htmlFor={`${id}-${name}`}>{label}</label>
    <input id={`${id}-${name}`} name={name} type="date" value={dates[name]} aria-invalid={Boolean(errors[name])}
      aria-describedby={errors[name] ? `${id}-${name}-error` : `${id}-note`}
      onChange={(event) => { setDates({ ...dates, [name]: event.target.value }); setErrors({}) }} />
    {errors[name] && <p className="spending-field-error" id={`${id}-${name}-error`}>{errors[name]}</p>}
  </div>
  return <form className="spending-form" noValidate aria-label="Свой период" onSubmit={(event) => {
    event.preventDefault()
    const result = applyFilters(query, { ...filterDraft(query), ...dates })
    const wrong: FilterErrors = {}
    for (const name of ['date_from', 'date_to'] as const) if (result.errors[name]) wrong[name] = filterMessages[name]
    setErrors(wrong)
    const first = Object.keys(wrong)[0]
    if (first) { event.currentTarget.querySelector<HTMLInputElement>(`[name="${first}"]`)?.focus(); return }
    onDone()
    navigate(spendingHref(result.query))
  }}>
    <div className="spending-grid">{field('date_from', 'С')}{field('date_to', 'По')}</div>
    <p className="spending-note" id={`${id}-note`}>Обе даты включительно, по дате покупки в магазине. Без дат — вся история.</p>
    <button type="submit">Показать период</button>
  </form>
}

/** «Всё время», «Этот год» or the dates themselves. */
function spendingPeriodLabel(query: SpendingQuery, today: string): ReactNode {
  const preset = activePreset(query, today)
  if (preset) return presetLabels[preset]
  if (query.date_from && query.date_to) return <DateRange from={query.date_from} to={query.date_to} />
  return query.date_from ? <>с <PeriodDate date={query.date_from} /></> : <>по <PeriodDate date={query.date_to ?? ''} /></>
}

/** «Период: …» of «Траты» on a phone: the ready periods and «Свой период» in a sheet. `open` — for the tests. */
export function SpendingPeriodSheet({ query, today, open }: { query: SpendingQuery; today: string; open?: boolean }) {
  const active = activePreset(query, today)
  return <PeriodSheet label={spendingPeriodLabel(query, today)} open={open}
    choices={presets.map((preset) => ({ key: preset, label: presetLabels[preset], href: presetHref(query, preset, today), active: active === preset }))}>
    {(close) => <SpendingPeriodForm query={query} onDone={close} />}
  </PeriodSheet>
}

export default function SpendingFilters({ query, failure, reference, today, narrow: narrowProp }: {
  query: SpendingQuery; failure?: SpendingFailure; reference: SpendingReference; today: string
  /** For the tests: the phone view without a browser. */
  narrow?: boolean
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
  const measured = useNarrow()
  const narrow = narrowProp ?? measured
  const presetsRef = useChipInView<HTMLElement>(`${active ?? ''}-${narrow}`)
  // The ready periods: on a wide screen chips above the form; on a phone «Период: …» opens them in a sheet, beside the
  // picture of the filters, and the dates of the form move into that sheet as «Свой период».
  const chips = <nav ref={presetsRef} className="spending-presets" aria-label="Быстрый выбор периода">
    <ChipScroller label="Готовые периоды">
      {presets.map((preset) => <Link key={preset} className="ck-chip" to={presetHref(query, preset, today)}
        aria-current={active === preset ? 'true' : undefined}>{presetLabels[preset]}</Link>)}
    </ChipScroller>
  </nav>

  return <section className="spending-panel spending-filters" aria-labelledby={`${id}-heading`}>
    <h2 id={`${id}-heading`}>Период и фильтры</h2>
    {!narrow && chips}
    <ResponsiveFilters count={filterCount(query)} summary={<SpendingPeriodSheet query={query} today={today} />} compact narrow={narrowProp}>
    <form ref={formRef} className="spending-form" noValidate onSubmit={(event) => {
      event.preventDefault()
      const result = applyFilters(query, draft)
      dispatch({ type: 'invalid', errors: result.errors })
      const invalid = Object.keys(result.errors)[0]
      if (invalid) focusField(invalid)
      else navigate(spendingHref(result.query))
    }}>
      {!narrow && <>
        <div className="spending-grid">{dateInput('date_from', 'Период с')}{dateInput('date_to', 'Период по')}</div>
        <p className="spending-note" id={`${id}-period-help`}>Обе даты включительно, по дате покупки в магазине. Без дат — вся история.</p>
      </>}
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
      {/* On a phone the dates are in the sheet of the period: their refusal is not one of these fields. */}
      {Object.keys(errors).some((field) => !narrow || !field.startsWith('date_')) && <p className="spending-field-error" role="alert">Исправьте отмеченные фильтры.</p>}
      <div className="spending-actions ck-action-bar">
        <button type="submit">{narrow ? 'Применить' : 'Применить фильтры'}</button>
        {/* «Сбросить» brings the default view back: the screen remembers the last one (stats-memory.ts). */}
        {(source !== '' || !sameDraft(draft, applied)) && <button type="button" className="spending-secondary" onClick={() => {
          dispatch({ type: 'reset' })
          navigate(spendingHref())
          focusField(narrow ? 'country' : 'date_from')
        }}>Сбросить</button>}
      </div>
    </form>
    </ResponsiveFilters>
  </section>
}
