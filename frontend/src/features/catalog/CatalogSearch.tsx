import { useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { ApiFailure, CategoryGeneric } from '../../api/types'
import { buildRoute, navigate } from '../../navigation'
import type { CatalogRoute } from '../../navigation'
import { fieldError, resetFilters, searchError, withGeneric, withSearch } from './catalog-state'

type Props = { route: CatalogRoute; generics?: CategoryGeneric[]; error?: ApiFailure }

export default function CatalogSearch({ route, generics, error }: Props) {
  const source = buildRoute(route)
  const [draft, setDraft] = useState({ source, value: route.query.q ?? '', submitted: false })
  // Derive draft from every History transition, without remounting or moving focus.
  if (draft.source !== source) setDraft({ source, value: route.query.q ?? '', submitted: false })
  const value = draft.source === source ? draft.value : route.query.q ?? ''
  const validation = searchError(value)
  const qError = validation ?? fieldError(error, 'q')
  const genericError = fieldError(error, 'generic')
  const input = useRef<HTMLInputElement>(null)
  const id = useId()
  const helpId = `${id}-help`
  const qErrorId = `${id}-q-error`
  const genericErrorId = `${id}-generic-error`
  const filtered = Boolean(route.query.q || route.query.generic !== undefined)
  const unknownGeneric = route.query.generic !== undefined && generics !== undefined
    && !generics.some((generic) => generic.id === route.query.generic)

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (validation) {
      setDraft({ source, value, submitted: true })
      input.current?.focus()
      return
    }
    navigate({ ...route, query: withSearch(route.query, value) })
  }
  const reset = () => {
    setDraft({ source: buildRoute(resetFilters(route)), value: '', submitted: false })
    navigate(resetFilters(route))
    input.current?.focus()
  }

  return <form className="ck-catalog-search ck-catalog-panel" onSubmit={submit} noValidate>
    <div className="ck-catalog-search-field">
      <label htmlFor={`${id}-q`}>{route.kind === 'catalog' ? 'Поиск товаров по всему каталогу' : 'Поиск товаров в этой ветви'}</label>
      <div className="ck-catalog-search-controls">
        <input id={`${id}-q`} ref={input} name="q" type="search" value={value}
          onChange={(event) => setDraft({ source, value: event.target.value, submitted: false })}
          aria-describedby={`${helpId}${qError ? ` ${qErrorId}` : ''}`} aria-invalid={qError ? true : undefined} />
        <button type="submit">Найти</button>
      </div>
      <p id={helpId} className="ck-catalog-note">От 2 до 100 символов. Поиск по названию, бренду, модели или GTIN.</p>
      {qError && <p id={qErrorId} className="ck-catalog-field-error" role={draft.submitted || fieldError(error, 'q') ? 'alert' : undefined}>{qError}</p>}
    </div>
    {generics !== undefined && <div className="ck-catalog-search-field">
      <label htmlFor={`${id}-generic`}>Обобщённый продукт</label>
      <select id={`${id}-generic`} name="generic" value={route.query.generic ?? ''}
        onChange={(event) => navigate({ ...route, query: withGeneric(route.query, event.target.value ? Number(event.target.value) : undefined) })}
        aria-describedby={genericError ? genericErrorId : undefined} aria-invalid={genericError ? true : undefined}>
        <option value="">Все обобщённые продукты</option>
        {unknownGeneric && <option value={route.query.generic}>Продукт № {route.query.generic?.toLocaleString('ru-RU')} — отсутствует в этой категории</option>}
        {generics.map((generic) => <option value={generic.id} key={generic.id}>{generic.name} — товаров: {generic.products_count.toLocaleString('ru-RU')}</option>)}
      </select>
      <p className="ck-catalog-note">Варианты из этой категории. Без фильтра — товары всей ветви.</p>
      {genericError && <p id={genericErrorId} className="ck-catalog-field-error" role="alert">{genericError}</p>}
    </div>}
    {route.kind === 'catalog' && route.query.generic !== undefined && <p className="ck-catalog-note">Выбран обобщённый продукт № {route.query.generic.toLocaleString('ru-RU')}.</p>}
    {filtered && <button className="ck-catalog-reset" type="button" onClick={reset}>Сбросить фильтры</button>}
  </form>
}
