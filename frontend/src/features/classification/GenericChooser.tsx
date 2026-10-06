import { useCallback, useEffect, useState } from 'react'
import { getGenericProducts } from '../../api/catalog'
import type { Classification } from '../../api/product-classifications'
import type { GenericProduct, Page } from '../../api/types'
import type { RequestState as State } from '../recognition/polling'
import { useRequest } from '../recognition/useRequest'
import { categoryText, errorText, named, unitLabels } from './labels'
import { chooseOptions, searchQuery } from './state'

export const chooserPageSize = 50

/** Pure markup of «Выбрать другой»: search, radio options and the two buttons. */
export function GenericChooserView({ record, text, state, selected, busy, saving, onText, onSelect, onApply, onCancel, onRetry }: {
  record: Classification; text: string; state: State<Page<GenericProduct>>; selected: number | undefined
  busy: boolean; saving: boolean
  onText: (text: string) => void; onSelect: (id: number) => void; onApply: () => void; onCancel: () => void; onRetry: () => void
}) {
  const id = `class-choose-${record.id}`
  const { short } = searchQuery(text)
  const options = state.kind === 'ok' ? chooseOptions(state.data.results, record) : []
  const chosen = !short && options.some((item) => item.id === selected) ? selected : undefined
  return <div className="ck-class-area" role="group" aria-labelledby={`${id}-title`}>
    <p id={`${id}-title`} className="ck-class-area-title">Другой обобщённый продукт для товара «{named(record.product)}»</p>
    <div className="ck-class-field">
      <label htmlFor={`${id}-search`}>Поиск обобщённого продукта</label>
      <input id={`${id}-search`} type="search" value={text} maxLength={100} autoComplete="off" disabled={busy} data-class-focus
        aria-describedby={`${id}-hint`} onChange={(event) => onText(event.target.value)} />
      <p id={`${id}-hint`} className="ck-class-note">Введите не меньше 2 символов. Без запроса показаны первые {chooserPageSize} по названию.</p>
    </div>
    <div className="ck-class-options" aria-live="polite" aria-busy={!short && state.kind === 'loading'}>
      {short ? <p className="ck-class-note">Для поиска нужно не меньше 2 символов.</p>
        : state.kind === 'loading' ? <p className="ck-class-note">Загружаем варианты…</p>
          : state.kind === 'error' ? <>
            <p className="ck-class-error">{errorText(state.error)}</p>
            <button type="button" className="ck-class-secondary" disabled={busy} onClick={onRetry}>Повторить</button>
          </> : <>
            {state.refreshError && <p className="ck-class-error">Не удалось обновить варианты, показаны последние полученные. {errorText(state.refreshError)}</p>}
            {options.length === 0 ? <p className="ck-class-note">Подходящих обобщённых продуктов нет. Измените запрос.</p>
              : <fieldset role="radiogroup" aria-required="true">
                <legend>Варианты</legend>
                {options.map((item) => <label className="ck-class-choice" key={item.id}>
                  <input type="radio" name={`${id}-option`} value={item.id} disabled={busy} checked={chosen === item.id} onChange={() => onSelect(item.id)} />
                  <span>{named(item)}<span className="ck-class-subtext">{categoryText(item.category)} · {unitLabels[item.base_unit]}</span></span>
                </label>)}
              </fieldset>}
            {state.data.count > state.data.results.length && <p className="ck-class-note">Показаны первые {state.data.results.length.toLocaleString('ru-RU')} из {state.data.count.toLocaleString('ru-RU')}: уточните запрос.</p>}
          </>}
    </div>
    <div className="ck-class-actions">
      <button type="button" disabled={busy || chosen === undefined} onClick={onApply}>{saving ? 'Сохраняем выбор…' : 'Применить выбор'}</button>
      <button type="button" className="ck-class-secondary" disabled={busy} onClick={onCancel}>Отмена</button>
    </div>
  </div>
}

/** The area under a record: its own request to the list of generic products, re-read after a refused choice. */
export default function GenericChooser({ record, busy, saving, reload, onApply, onCancel }: {
  record: Classification; busy: boolean; saving: boolean
  /** Grows when the server refused the chosen option: the options are read again. */
  reload: number
  onApply: (genericId: number) => void; onCancel: () => void
}) {
  const [text, setText] = useState('')
  const [q, setQ] = useState<string>()
  const [selected, setSelected] = useState<number>()
  const wanted = searchQuery(text)
  // A short pause after typing: one request per pause, never one per key.
  useEffect(() => {
    if (wanted.short) return
    const timer = setTimeout(() => setQ(wanted.q), 300)
    return () => clearTimeout(timer)
  }, [wanted.q, wanted.short])
  const load = useCallback((signal: AbortSignal) => getGenericProducts({ ...(q !== undefined && { q }), page_size: chooserPageSize }, { signal }), [q])
  const { state, request } = useRequest(load)
  // Reads wait while an action is being saved.
  useEffect(() => {
    if (!busy) return
    request.pause()
    return () => request.resume(false)
  }, [busy, request])
  useEffect(() => { if (reload > 0) request.queueRefresh() }, [reload, request])
  return <GenericChooserView record={record} text={text} state={state} selected={selected} busy={busy} saving={saving}
    onText={setText} onSelect={setSelected} onRetry={request.refresh} onCancel={onCancel}
    onApply={() => { if (selected !== undefined) onApply(selected) }} />
}
