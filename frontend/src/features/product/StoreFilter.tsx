import { useCallback, useState } from 'react'
import { getStores } from '../../api/stores'
import type { Store, StoreBrief } from '../../api/types'
import { parseCatalogQuery } from '../../navigation/routes'
import RequestState from '../../components/RequestState'
import { errorMessage, mergeStores, storeLabel, storeParams } from './state'
import { useProductRequest } from './useProductRequest'

export default function StoreFilter({ country, value, initial, known = [], selected, error, onChange, onStores }: {
  country: string; value: string; initial: Store[]; known?: Store[]; selected?: StoreBrief; error?: string
  onChange: (value: string) => void; onStores: (stores: Store[]) => void
}) {
  const [text, setText] = useState('')
  const [searchError, setSearchError] = useState('')
  const [search, setSearch] = useState({ country, q: '', page: 1 })
  if (search.country !== country) setSearch({ country, q: search.q, page: 1 })
  const load = useCallback(async (signal: AbortSignal) => {
    const result = await getStores(storeParams(country, search.q, search.page), { signal })
    if (result.kind === 'ok' && !signal.aborted) onStores(result.data.results)
    return result
  }, [country, search.q, search.page, onStores])
  const { state, retry } = useProductRequest(load)
  const unavailable = state.kind === 'error'
  const options = mergeStores(initial, state.kind === 'ok' ? state.data.results : []).filter((store) => !country || store.country === country)
  const knownStores = new Map(known.map((store) => [store.id, store]))
  const selectedStore = knownStores.get(Number(value)) ?? (String(selected?.id) === value ? selected : undefined)
  const find = () => {
    const parsed = parseCatalogQuery(new URLSearchParams({ q: text }))
    if (parsed.invalidFields.length) {
      setSearchError('Введите от 2 до 100 символов без управляющих знаков или оставьте поиск пустым.')
      return
    }
    setSearchError('')
    if (search.q === (parsed.query.q ?? '') && search.page === 1) retry()
    else setSearch({ country, q: parsed.query.q ?? '', page: 1 })
  }
  const qError = searchError || (state.kind === 'error' && state.status === 400 && state.fields?.includes('q') && text.trim() === search.q
    ? 'Исправьте поиск: от 2 до 100 символов или пустое поле.' : '')

  return (
    <fieldset className="product-store-filter" aria-busy={state.kind === 'loading'}>
      <legend>Магазин</legend>
      <label htmlFor="product-store">Магазин для фильтра истории</label>
      <select id="product-store" value={value} onChange={(event) => onChange(event.target.value)} disabled={unavailable}
        aria-invalid={Boolean(error)} aria-describedby={`product-store-note${error ? ' product-store-error' : ''}`}>
        <option value="">Все магазины</option>
        {value && !options.some((store) => String(store.id) === value) && <option value={value}>{storeLabel(selectedStore ?? { id: Number(value) })}</option>}
        {options.map((store) => <option key={store.id} value={store.id}>{storeLabel(knownStores.get(store.id) ?? store)}</option>)}
      </select>
      <p id="product-store-note" className="product-note">{unavailable ? 'Фильтр магазина недоступен. История и остальные фильтры работают; выбранный магазин можно убрать кнопкой ниже.' : 'Начальные варианты из карточки могут быть неполными (до 50). Поиск охватывает все магазины выбранной страны, в том числе без покупок этого товара.'}</p>
      {error && <p className="product-field-error" id="product-store-error">{error}</p>}
      {value && <button type="button" className="product-secondary" onClick={() => onChange('')}>Убрать магазин</button>}
      <label htmlFor="product-store-search">Найти магазин по названию или городу</label>
      <div className="product-store-search">
        <input id="product-store-search" type="search" value={text} onChange={(event) => { setText(event.target.value); setSearchError('') }}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); find() } }}
          aria-invalid={Boolean(qError)} aria-describedby={`product-store-search-note${qError ? ' product-store-search-error' : ''}`} />
        <button type="button" onClick={find}>Найти</button>
      </div>
      <p id="product-store-search-note" className="product-note">От 2 до 100 символов. Пустой поиск показывает все магазины. После выбора нажмите «Применить фильтры».</p>
      {qError && <p className="product-field-error" id="product-store-search-error">{qError}</p>}
      {state.kind === 'loading' && <RequestState kind="loading" message="Загружаем справочник магазинов…" />}
      {state.kind === 'error' && <>
        <p className="product-field-error" role="status">Не удалось загрузить справочник магазинов. {errorMessage(state)}</p>
        {state.status === 400 ? <button type="button" onClick={() => { setText(''); setSearchError(''); setSearch({ country, q: '', page: 1 }) }}>Сбросить поиск магазинов</button>
          : state.reason === 'page_out_of_range' ? <button type="button" onClick={() => setSearch({ ...search, page: 1 })}>Первая страница магазинов</button>
            : <button type="button" onClick={retry}>Повторить</button>}
      </>}
      {state.kind === 'ok' && <>
        <p className="product-note" role="status">{state.data.count === 0 ? 'Магазины по этому поиску не найдены.' : `Найдено магазинов: ${state.data.count.toLocaleString('ru-RU')}. Страница ${state.data.page.toLocaleString('ru-RU')} из ${state.data.pages.toLocaleString('ru-RU')}. Варианты доступны в поле выбора выше.`}</p>
        {state.data.pages > 1 && <div className="product-actions" aria-label="Страницы справочника магазинов">
          <button type="button" disabled={state.data.page === 1} onClick={() => setSearch({ ...search, page: search.page - 1 })}>Предыдущие магазины</button>
          <button type="button" disabled={state.data.page === state.data.pages} onClick={() => setSearch({ ...search, page: search.page + 1 })}>Следующие магазины</button>
        </div>}
      </>}
    </fieldset>
  )
}
