import { useCallback, useEffect, useRef, useState } from 'react'
import type { FocusEvent, MouseEvent, ReactNode } from 'react'
import type { CountryEntry } from '../../api/countries'
import { getStores } from '../../api/stores'
import type { StoreEntry, Unit } from '../../api/types'
import { formatUnit } from '../../lib/format'
import { errorText } from './labels'
import { focusAfterAttribute, focusAfterPress, replacedFieldKeepsFocus } from './review-actions'
import { addField, headerField, problemsAt, rowField, storeLabel } from './review-state'
import type { ReviewEdit, ReviewHeader, ReviewLine, ReviewList, ReviewState, ReviewStore } from './review-state'
import { useRequest } from './useRequest'

const kinds = { product: 'Товар', service: 'Услуга', deposit: 'Залог', deposit_return: 'Возврат залога' }
const units: Unit[] = ['pcs', 'g', 'kg', 'ml', 'l', 'm']
const decimalHint = 'Запятая или точка.'
type Option = [value: string, label: string]
type FieldBox = { id: string; label: string; problems: string[]; unread?: boolean; hint?: string }
type Described = { id: string; 'aria-invalid': true | undefined; 'aria-describedby': string | undefined }

/** A labelled control with its unread mark, hint and problem text tied to it by aria-describedby. */
function Field({ id, label, problems, unread = false, hint, children }: FieldBox & { children: (attrs: Described) => ReactNode }) {
  const described = [unread && `${id}-unread`, hint && `${id}-hint`, problems.length > 0 && `${id}-error`].filter(Boolean).join(' ')
  return <div className="ck-review-field">
    <label htmlFor={id}>{label}</label>
    {children({ id, 'aria-invalid': problems.length > 0 || undefined, 'aria-describedby': described || undefined })}
    {unread && <p id={`${id}-unread`} className="ck-review-unread">Не прочитано</p>}
    {hint && <p id={`${id}-hint`} className="ck-rec-note">{hint}</p>}
    {problems.length > 0 && <p id={`${id}-error`} className="ck-review-error">{problems.join(' ')}</p>}
  </div>
}

/** `focus` is the DOM id of the search field: «Повторить поиск» disappears with its press and hands focus to it. */
export function StoreResults({ query, disabled, focus, onChoose }: { query: string; disabled: boolean; focus: string; onChoose: (store: StoreEntry) => void }) {
  const load = useCallback((signal: AbortSignal) => getStores({ q: query }, { signal }), [query])
  const { state, request } = useRequest(load)
  if (state.kind === 'loading') return <p role="status">Ищем магазины…</p>
  if (state.kind === 'error') return <div className="ck-rec-warning" role="status">
    <p>Не удалось найти магазины. {errorText(state.error)}</p>
    <button type="button" disabled={disabled} {...{ [focusAfterAttribute]: focus }} onClick={request.refresh}>Повторить поиск</button>
  </div>
  const { results, count } = state.data
  if (results.length === 0) return <p role="status">Магазины не найдены. Измените запрос или укажите вывеску и адрес ниже.</p>
  return <>
    <p role="status">Найдено магазинов: {count.toLocaleString('ru-RU')}{count > results.length ? `. Показаны первые ${results.length}: уточните запрос.` : '.'}</p>
    <ul className="ck-review-stores">{results.map((store) => <li key={store.id}>
      <button type="button" className="ck-review-secondary" disabled={disabled} onClick={() => onChoose(store)}>Выбрать: {storeLabel(store)}</button>
    </li>)}</ul>
  </>
}

/** An existing store by GET /api/stores/?q=, sent as store_id. Its search text is local and never part of the body. */
function StoreChooser({ id, store, problems, disabled, onStore }: {
  id: string; store: ReviewStore | null; problems: string[]; disabled: boolean; onStore: (store: ReviewStore | null) => void
}) {
  const [text, setText] = useState('')
  const [query, setQuery] = useState('')
  const [short, setShort] = useState(false)
  const status = useRef<HTMLParagraphElement>(null)
  const moved = useRef(false)
  // The pressed «Выбрать»/«Не использовать» button disappears: its result line takes focus.
  useEffect(() => { if (moved.current) { moved.current = false; status.current?.focus() } }, [store])
  const choose = (next: ReviewStore | null) => { moved.current = true; setQuery(''); onStore(next) }
  const search = () => {
    const value = text.trim()
    const valid = Array.from(value).length >= 2
    setShort(!valid)
    setQuery(valid ? value : '')
  }
  return <div className="ck-review-store">
    <p ref={status} tabIndex={-1} className={store ? 'ck-review-chosen' : 'ck-rec-note'}>{store
      ? <>Выбран существующий магазин: <strong>{store.label}</strong>. Вывеска, адрес и страна ниже в выборе магазина не участвуют; страна чека — страна магазина.</>
      : 'Существующий магазин не выбран: сервер найдёт или создаст магазин по вывеске, адресу и стране. Если причины называют несколько подходящих магазинов или противоречие — выберите магазин здесь.'}</p>
    {store && <button type="button" className="ck-review-secondary" disabled={disabled} onClick={() => choose(null)}>Не использовать выбранный магазин</button>}
    <Field id={id} label="Найти существующий магазин" problems={[...problems, ...(short ? ['Введите не меньше двух символов.'] : [])]} hint="Вывеска, название или город. Поиск не меняет данные формы.">
      {(attrs) => <div className="ck-review-search">
        <input {...attrs} type="search" maxLength={100} value={text} disabled={disabled} onChange={(event) => { setText(event.target.value); setShort(false) }}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); search() } }} />
        <button type="button" className="ck-review-secondary" disabled={disabled} onClick={search}>Найти</button>
      </div>}
    </Field>
    {query && <StoreResults query={query} disabled={disabled} focus={id} onChoose={(found) => choose({ id: found.id, label: storeLabel(found) })} />}
  </div>
}

export type ReviewFormProps = {
  imageId: number; state: ReviewState; dispatch: (edit: ReviewEdit) => void
  /** null until the reference is read, and when its read failed: the country is then typed as a code. */
  countries: CountryEntry[] | null; countriesFailed?: boolean; onCountriesRetry?: () => void
  pending: boolean
  /** Why the confirmation cannot be sent now; undefined when it can. */
  unavailable?: string
  /** Text of the last refused confirmation of this crop: shown and announced next to the button. */
  refusal?: string
  onConfirm: () => void
}

/** Correction form of one needs_review crop. No <form>: Enter in a field must not save a receipt by accident. */
export default function ReviewForm({ imageId, state, dispatch, countries, countriesFailed = false, onCountriesRetry, pending, unavailable, refusal, onConfirm }: ReviewFormProps) {
  const dom = useCallback((field: string) => `review-${imageId}-${field.replaceAll('.', '-')}`, [imageId])
  const notice = useRef<HTMLParagraphElement>(null)
  const seen = useRef(state.notice.id)
  useEffect(() => {
    if (seen.current === state.notice.id) return
    seen.current = state.notice.id
    // The announcement itself is a live region and needs no focus; it takes it only if the named field is not in the document.
    const target = state.notice.focus === null ? null : document.getElementById(dom(state.notice.focus))
    ;(target ?? notice.current)?.focus()
  }, [state.notice, dom])
  const lastFocused = useRef<string | null>(null)
  const focused = (event: FocusEvent<HTMLElement>) => { lastFocused.current = event.target.id || null }
  // Runs after the button's own handler, before its press removes it from the page.
  const pressed = (event: MouseEvent<HTMLElement>) => {
    const id = focusAfterPress(event.target as Element)
    if (id !== null) document.getElementById(id)?.focus()
  }
  const countryId = dom(headerField('country'))
  const listed = countries !== null
  // The loaded reference replaces the typed country code by a select: a new element under the same id.
  useEffect(() => {
    const active = document.activeElement
    if (replacedFieldKeepsFocus(lastFocused.current, countryId, !active || active === document.body ? 'body' : 'elsewhere')) document.getElementById(countryId)?.focus()
  }, [listed, countryId])

  const box = (field: string, label: string, value: string, hint?: string, ...also: string[]): FieldBox => ({
    id: dom(field), label, hint, problems: problemsAt(state, field, ...also), unread: value === '' && state.unread.includes(field),
  })
  const input = (field: string, label: string, value: string, change: (value: string) => void, options: { hint?: string; type?: string; mode?: 'decimal'; max?: number; list?: string; disabled?: boolean } = {}) =>
    <Field {...box(field, label, value, options.hint)}>{(attrs) => <input {...attrs} type={options.type ?? 'text'} inputMode={options.mode} maxLength={options.max}
      list={options.list} disabled={options.disabled} autoComplete="off" value={value} onChange={(event) => change(event.target.value)} />}</Field>
  const select = (field: string, label: string, value: string, choices: Option[], change: (value: string) => void, hint?: string, ...also: string[]) =>
    <Field {...box(field, label, value, hint, ...also)}>{(attrs) => <select {...attrs} value={value} onChange={(event) => change(event.target.value)}>
      {choices.map(([option, text]) => <option value={option} key={option}>{text}</option>)}
    </select>}</Field>
  const sectionProblems = (list: ReviewList) => problemsAt(state, list).length > 0 && <p className="ck-review-error" role="alert">{problemsAt(state, list).join(' ')}</p>
  const rowProblems = (list: ReviewList, key: number) => problemsAt(state, rowField(list, key)).length > 0
    && <p className="ck-review-error">{problemsAt(state, rowField(list, key)).join(' ')}</p>

  const { header } = state
  const head = (patch: Partial<ReviewHeader>) => dispatch({ type: 'header', patch })
  const known = countries ?? []
  const countryChoices: Option[] = [['', 'Не указана'], ...known.map((item): Option => [item.code, `${item.code} · ${item.name}`]),
    ...(header.country && !known.some((item) => item.code === header.country) ? [[header.country, `${header.country} · нет в справочнике`] as Option] : [])]
  const currencies = [...new Set(known.flatMap((item) => item.currencies))].sort()
  const lineTitle = (line: ReviewLine, index: number) => `Строка ${index + 1}${line.name.trim() ? `: ${line.name.trim()}` : ''}`
  const lineChoices = (allowed: (line: ReviewLine) => boolean, none: string): Option[] => [['', none],
    ...state.lines.flatMap((line, index): Option[] => allowed(line) ? [[String(line.key), lineTitle(line, index)]] : [])]
  const rate = (list: 'lines' | 'taxes', row: { key: number; taxKind: string; taxRate: string }, change: (patch: { taxKind?: 'vat' | 'exempt' | ''; taxRate?: string }) => void) => {
    const id = rowField(list, row.key)
    const choices: Option[] = [...(list === 'lines' ? [['', 'Нет ставки'] as Option] : row.taxKind === '' ? [['', 'Не выбран'] as Option] : []), ['vat', 'НДС'], ['exempt', 'Без налога']]
    return <>
      {select(`${id}.tax_rate.kind`, 'Вид налога', row.taxKind, choices, (value) => change({ taxKind: value as 'vat' | 'exempt' | '' }), undefined, `${id}.tax_rate`)}
      {input(`${id}.tax_rate.rate`, 'Ставка НДС, %', row.taxRate, (value) => change({ taxRate: value }), { mode: 'decimal', max: 8, disabled: row.taxKind !== 'vat', hint: row.taxKind === 'vat' ? 'Например 7,00.' : 'Только для НДС.' })}
    </>
  }

  return <section className="ck-review" aria-label="Исправление и подтверждение распознанных данных" onFocus={focused} onClick={pressed}>
    <h4>Исправление и подтверждение</h4>
    <p className="ck-rec-warning">Проверьте данные по изображению чека, исправьте их и подтвердите. Несохранённые правки хранятся только на этой открытой странице: перезагрузка или закрытие вкладки их стирает, черновика на сервере нет.</p>
    <p className="ck-rec-note">Заполненное поле считается прочитанным с чека, пустое — отсутствующим. Если сомневаетесь в значении, очистите поле. Суммы и количества: {decimalHint.toLowerCase()}</p>
    <fieldset className="ck-review-body" disabled={pending}>
      <legend className="ck-review-hidden">Данные чека</legend>
      <fieldset className="ck-review-group">
        <legend>Магазин</legend>
        <StoreChooser id={dom('receipt.store')} store={header.store} problems={problemsAt(state, 'receipt.store')} disabled={pending} onStore={(store) => head({ store })} />
        <div className="ck-review-grid">
          {input(headerField('storeName'), 'Вывеска', header.storeName, (storeName) => head({ storeName }), { max: 100 })}
          {input(headerField('address'), 'Адрес', header.address, (address) => head({ address }), { max: 4096 })}
          {countries
            ? select(headerField('country'), 'Страна', header.country, countryChoices, (country) => head({ country }))
            : input(headerField('country'), 'Страна', header.country, (country) => head({ country }), { max: 2, hint: 'Код из двух букв, например DE.' })}
        </div>
        {countriesFailed && <div className="ck-rec-warning" role="status">
          <p>Справочник стран не загружен: код страны и валюты введите вручную.</p>
          <button type="button" className="ck-review-secondary" {...{ [focusAfterAttribute]: countryId }} onClick={onCountriesRetry}>Загрузить справочник</button>
        </div>}
      </fieldset>
      <fieldset className="ck-review-group">
        <legend>Чек</legend>
        <div className="ck-review-grid">
          {input(headerField('purchasedOn'), 'Дата на чеке', header.purchasedOn, (purchasedOn) => head({ purchasedOn }), { type: 'date' })}
          {input(headerField('localTime'), 'Местное время', header.localTime, (localTime) => head({ localTime }), { max: 8, hint: 'ЧЧ:ММ или ЧЧ:ММ:СС, как на чеке.' })}
          {input(headerField('utcOffset'), 'Смещение от UTC', header.utcOffset, (utcOffset) => head({ utcOffset }), { max: 6, hint: 'Необязательно: +02:00. Нужно только для часа перевода часов.' })}
          {select(headerField('operation'), 'Операция', header.operation, [['', 'Не указана — определит сервер'], ['sale', 'Покупка'], ['refund', 'Возврат']], (operation) => head({ operation: operation as ReviewHeader['operation'] }))}
          {input(headerField('currency'), 'Валюта', header.currency, (currency) => head({ currency }), { max: 3, list: dom('currencies'), hint: 'Код из трёх букв, например EUR.' })}
          {input(headerField('total'), 'Итого', header.total, (total) => head({ total }), { mode: 'decimal', max: 20 })}
          {select(headerField('pricesIncludeTax'), 'Налог включён в цены', header.pricesIncludeTax, [['', 'Не указано — сервер примет «включён»'], ['yes', 'Включён'], ['no', 'Не включён']],
            (value) => head({ pricesIncludeTax: value as ReviewHeader['pricesIncludeTax'] }))}
        </div>
        <datalist id={dom('currencies')}>{currencies.map((currency) => <option value={currency} key={currency} />)}</datalist>
      </fieldset>

      <h4>Строки ({state.lines.length})</h4>
      {sectionProblems('lines')}
      {state.lines.length === 0 && <p>Строк нет. Чек без строк сохранить нельзя.</p>}
      <ol className="ck-rec-list">{state.lines.map((line, index) => {
        const id = rowField('lines', line.key)
        const edit = (patch: Extract<ReviewEdit, { type: 'line' }>['patch']) => dispatch({ type: 'line', key: line.key, patch })
        return <li key={line.key}><fieldset className="ck-review-group">
          <legend>Строка {index + 1}{line.source === null && ' · добавлена вручную'}</legend>
          {rowProblems('lines', line.key)}
          <div className="ck-review-grid">
            {input(`${id}.name`, 'Название', line.name, (name) => edit({ name }), { max: 4096 })}
            {select(`${id}.kind`, 'Тип строки', line.kind, [...(line.kind === '' ? [['', 'Не выбран'] as Option] : []), ...Object.entries(kinds)], (kind) => edit({ kind: kind as ReviewLine['kind'] }))}
            {line.kind === 'deposit' && select(`${id}.parent_position`, 'Залог к строке', line.parent === null ? '' : String(line.parent),
              lineChoices((candidate) => candidate.kind === 'product' && candidate.key !== line.key, 'Не связан'), (parent) => edit({ parent: parent === '' ? null : Number(parent) }))}
            {input(`${id}.quantity`, 'Количество', line.quantity, (quantity) => edit({ quantity }), { mode: 'decimal', max: 20 })}
            {select(`${id}.unit`, 'Единица', line.unit, [['', 'Не указана'], ...units.map((unit): Option => [unit, formatUnit(unit)])], (unit) => edit({ unit: unit as ReviewLine['unit'] }))}
            {input(`${id}.unit_price`, 'Цена за единицу', line.unitPrice, (unitPrice) => edit({ unitPrice }), { mode: 'decimal', max: 20 })}
            {input(`${id}.amount`, 'Сумма', line.amount, (amount) => edit({ amount }), { mode: 'decimal', max: 20 })}
            {rate('lines', line, edit)}
            {input(`${id}.tax_code`, 'Код налога', line.taxCode, (taxCode) => edit({ taxCode }), { max: 8 })}
          </div>
          <button type="button" className="ck-review-secondary" onClick={() => dispatch({ type: 'remove', list: 'lines', key: line.key })}>Удалить строку {index + 1}</button>
        </fieldset></li>
      })}</ol>
      <button type="button" id={dom(addField('lines'))} className="ck-review-secondary" onClick={() => dispatch({ type: 'add', list: 'lines' })}>Добавить строку</button>

      <h4>Скидки ({state.discounts.length})</h4>
      {sectionProblems('discounts')}
      {state.discounts.length === 0 && <p>Скидок нет.</p>}
      <ol className="ck-rec-list">{state.discounts.map((discount, index) => {
        const id = rowField('discounts', discount.key)
        const edit = (patch: Extract<ReviewEdit, { type: 'discount' }>['patch']) => dispatch({ type: 'discount', key: discount.key, patch })
        return <li key={discount.key}><fieldset className="ck-review-group">
          <legend>Скидка {index + 1}</legend>
          {rowProblems('discounts', discount.key)}
          <div className="ck-review-grid">
            {input(`${id}.name`, 'Название скидки', discount.name, (name) => edit({ name }), { max: 255 })}
            {input(`${id}.amount`, 'Сумма скидки', discount.amount, (amount) => edit({ amount }), { mode: 'decimal', max: 20, hint: 'Больше нуля.' })}
            {select(`${id}.line_position`, 'К чему относится', discount.line === null ? '' : String(discount.line), lineChoices(() => true, 'Весь чек'), (line) => edit({ line: line === '' ? null : Number(line) }))}
          </div>
          <button type="button" className="ck-review-secondary" onClick={() => dispatch({ type: 'remove', list: 'discounts', key: discount.key })}>Удалить скидку {index + 1}</button>
        </fieldset></li>
      })}</ol>
      <button type="button" id={dom(addField('discounts'))} className="ck-review-secondary" onClick={() => dispatch({ type: 'add', list: 'discounts' })}>Добавить скидку</button>

      <h4>Налоговые итоги ({state.taxes.length})</h4>
      {sectionProblems('taxes')}
      {state.taxes.length === 0 && <p>Налоговых итогов нет.</p>}
      <ol className="ck-rec-list">{state.taxes.map((tax, index) => {
        const id = rowField('taxes', tax.key)
        const edit = (patch: Extract<ReviewEdit, { type: 'tax' }>['patch']) => dispatch({ type: 'tax', key: tax.key, patch })
        return <li key={tax.key}><fieldset className="ck-review-group">
          <legend>Налоговый итог {index + 1}</legend>
          {rowProblems('taxes', tax.key)}
          <div className="ck-review-grid">
            {rate('taxes', tax, edit)}
            {input(`${id}.tax_code`, 'Код налога', tax.taxCode, (taxCode) => edit({ taxCode }), { max: 8 })}
            {input(`${id}.net`, 'Сумма без налога', tax.net, (net) => edit({ net }), { mode: 'decimal', max: 20 })}
            {input(`${id}.tax`, 'Сумма налога', tax.tax, (value) => edit({ tax: value }), { mode: 'decimal', max: 20 })}
            {input(`${id}.gross`, 'Сумма с налогом', tax.gross, (gross) => edit({ gross }), { mode: 'decimal', max: 20, hint: 'Одну из трёх сумм можно оставить пустой.' })}
          </div>
          <button type="button" className="ck-review-secondary" onClick={() => dispatch({ type: 'remove', list: 'taxes', key: tax.key })}>Удалить налоговый итог {index + 1}</button>
        </fieldset></li>
      })}</ol>
      <button type="button" id={dom(addField('taxes'))} className="ck-review-secondary" onClick={() => dispatch({ type: 'add', list: 'taxes' })}>Добавить налоговый итог</button>
    </fieldset>
    <p ref={notice} tabIndex={-1} role="status" className="ck-review-notice">{state.notice.text}</p>
    <p role="status" className="ck-review-refusal">{refusal ?? ''}</p>
    {/* Pinned to the bottom of a phone while this form is longer than the screen: buttons only, the note stays in the flow below. */}
    <div className="ck-rec-action-block ck-action-bar">
      <div className="ck-rec-actions">
        {/* Not `disabled` while its own request runs: the pressed button keeps focus, a second press does nothing. */}
        <button type="button" data-review-confirm disabled={unavailable !== undefined} aria-disabled={pending || undefined} aria-describedby={dom('confirm-note')} onClick={pending ? undefined : onConfirm}>{pending ? 'Сохраняем чек…' : 'Подтвердить и сохранить чек'}</button>
      </div>
    </div>
    <p id={dom('confirm-note')} className="ck-rec-note">{unavailable ?? 'Одно нажатие — один запрос. После сохранения чек через эту форму изменить нельзя.'}</p>
  </section>
}
