import { useId, useRef, useState } from 'react'
import { buildReceiptsQuery, navigate } from '../../navigation'
import type { ReceiptsQuery } from '../../navigation'
import { applyFilters, filterDraft, filterMessages, hasFilters } from './state'
import type { Failure, FilterErrors, FilterField } from './state'

export default function ReceiptFilters({ query, failure }: { query: ReceiptsQuery; failure?: Failure }) {
  const source = buildReceiptsQuery(query)
  const [form, setForm] = useState({ source, draft: filterDraft(query), errors: {} as FilterErrors })
  if (form.source !== source) setForm({ source, draft: filterDraft(query), errors: {} })
  const formRef = useRef<HTMLFormElement>(null)
  const id = useId()
  const draft = form.source === source ? form.draft : filterDraft(query)
  const errors = { ...form.errors }
  if (failure?.reason === 'invalid_parameter') {
    for (const field of failure.fields ?? []) {
      if (field in filterMessages && draft[field as FilterField] === filterDraft(query)[field as FilterField]) {
        errors[field as FilterField] = filterMessages[field as FilterField]
      }
    }
  }
  const update = (field: FilterField, value: string) => setForm({ source, draft: { ...draft, [field]: value }, errors: {} })
  const input = (field: 'q' | 'date_from' | 'date_to', label: string, type: 'search' | 'date') => <div className="receipt-field">
    <label htmlFor={`${id}-${field}`}>{label}</label>
    <input id={`${id}-${field}`} name={field} type={type} value={draft[field]} onChange={(event) => update(field, event.target.value)}
      aria-invalid={Boolean(errors[field])} aria-describedby={`${id}-help${errors[field] ? ` ${id}-${field}-error` : ''}`} />
    {errors[field] && <p className="receipt-field-error" id={`${id}-${field}-error`}>{errors[field]}</p>}
  </div>
  const select = (field: 'operation' | 'ordering', label: string, options: [string, string][]) => <div className="receipt-field">
    <label htmlFor={`${id}-${field}`}>{label}</label>
    <select id={`${id}-${field}`} name={field} value={draft[field]} onChange={(event) => update(field, event.target.value)}
      aria-invalid={Boolean(errors[field])} aria-describedby={errors[field] ? `${id}-${field}-error` : undefined}>
      {options.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
    </select>
    {errors[field] && <p className="receipt-field-error" id={`${id}-${field}-error`}>{errors[field]}</p>}
  </div>
  return <section className="receipt-panel" aria-labelledby={`${id}-heading`}>
    <h2 id={`${id}-heading`}>Найти чек</h2>
    <form ref={formRef} noValidate onSubmit={(event) => {
      event.preventDefault()
      const result = applyFilters(query, draft)
      setForm({ source, draft, errors: result.errors })
      const field = Object.keys(result.errors)[0]
      if (field) (formRef.current?.elements.namedItem(field) as HTMLElement | null)?.focus()
      else navigate({ kind: 'receipts', query: result.query })
    }}>
      {input('q', 'Магазин или товар в чеке', 'search')}
      <div className="receipt-filter-grid">{input('date_from', 'Период с', 'date')}{input('date_to', 'Период по', 'date')}</div>
      <p className="receipt-note" id={`${id}-help`}>Поиск: от 2 до 100 символов. Обе даты включительно, по дате покупки в магазине.</p>
      <div className="receipt-filter-grid">
        {select('operation', 'Операция', [['', 'Все операции'], ['sale', 'Продажа'], ['refund', 'Возврат']])}
        {select('ordering', 'По дате покупки', [['-purchased_at', 'Новые первыми'], ['purchased_at', 'Старые первыми']])}
      </div>
      {(query.store || query.product || query.country || query.currency) && <p className="receipt-note">
        Фильтры из ссылки: {[
          query.store && `магазин ID ${query.store}`, query.product && `товар ID ${query.product}`,
          query.country && `страна ${query.country}`, query.currency && `валюта ${query.currency}`,
        ].filter(Boolean).join(' · ')}. Они сохраняются при поиске.
      </p>}
      {Object.keys(errors).length > 0 && <p className="receipt-field-error" role="alert">Исправьте поля фильтров.</p>}
      <div className="receipt-actions">
        <button type="submit">Применить фильтры</button>
        {(hasFilters(query) || JSON.stringify(draft) !== JSON.stringify(filterDraft(query))) &&
          <button type="button" className="receipt-secondary" onClick={() => {
            setForm({ source, draft: filterDraft({ page: 1 }), errors: {} })
            navigate({ kind: 'receipts', query: { page: 1 } })
            const search = formRef.current?.elements.namedItem('q') as HTMLElement | null
            search?.focus()
          }}>Сбросить фильтры</button>}
      </div>
    </form>
  </section>
}
