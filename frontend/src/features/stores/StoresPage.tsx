import { useEffect, useRef, useState } from 'react'
import { dismissStores, getStoresState, mergeStores } from '../../api/store-merges'
import type { StoresState } from '../../api/store-merges'
import type { LocalApiResult } from '../../api/types'
import RequestState from '../../components/RequestState'
import Sheet from '../../components/Sheet'
import { errorMessage } from '../receipts/state'
import { defaultMain, filterStores, mergedNotice, pick, spendsText, storeMeta, storesFailure, storesTexts } from './stores-state'
import './Stores.css'

/** The merge being asked about in the sheet: the stores and the one to keep. */
export type MergeAsk = { ids: number[]; main: number }

export type StoresViewProps = {
  state: StoresState
  search: string
  selected: number[]
  ask: MergeAsk | null
  busy: boolean
  notice?: string
  failure?: string
  onSearch: (text: string) => void
  onToggle: (id: number) => void
  onAsk: (ids: number[]) => void
  onMain: (id: number) => void
  onCancel: () => void
  onMerge: () => void
  onDismiss: (ids: number[]) => void
}

/** The screen without the network: the markup tests render it directly. */
export function StoresView({ state, search, selected, ask, busy, notice, failure, onSearch, onToggle, onAsk, onMain, onCancel, onMerge, onDismiss }: StoresViewProps) {
  const shown = filterStores(state.stores, search)
  const asked = ask ? pick(state, ask.ids) : []
  return <div className="stores-page">
    <p className="stores-intro">{storesTexts.intro}</p>
    {notice && <p className="stores-notice" role="status">{notice}</p>}
    {failure && <p className="stores-failure" role="alert">{failure}</p>}

    {state.can_merge && state.suggestions.length > 0 && <section className="ck-panel stores-suggestions" aria-labelledby="stores-suggestions-title">
      <div className="ck-panel-head"><h2 id="stores-suggestions-title">Похоже на одного получателя</h2></div>
      <ul className="ck-list">
        {state.suggestions.map((suggestion) => {
          const stores = pick(state, suggestion.stores)
          return <li key={suggestion.stores.join('-')} className="stores-suggestion">
            <div className="ck-row-main">
              <span className="stores-names">{stores.map((store) => store.name).join(' · ')}</span>
              <span className="ck-row-meta">{stores.map((store) => spendsText(store.receipts_count)).join(' · ')}
                {suggestion.source === 'model' ? ' · по мнению модели' : ''}</span>
            </div>
            <div className="stores-suggestion-actions">
              <button type="button" disabled={busy} onClick={() => onAsk(suggestion.stores)}>Склеить</button>
              <button type="button" className="ck-button-secondary" disabled={busy} onClick={() => onDismiss(suggestion.stores)}>Не то</button>
            </div>
          </li>
        })}
      </ul>
    </section>}

    <section className="ck-panel" aria-labelledby="stores-all-title">
      <div className="ck-panel-head"><h2 id="stores-all-title">Все магазины</h2><span className="stores-total">{state.stores.length}</span></div>
      {state.stores.length > 0 && <label className="stores-search">
        <span className="stores-visually-hidden">Найти магазин</span>
        <input type="search" autoComplete="off" placeholder="Найти магазин" value={search} onChange={(event) => onSearch(event.target.value)} />
      </label>}
      {!state.can_merge && state.stores.length > 1 && <p className="stores-note">{storesTexts.moderatorOnly}</p>}
      {state.stores.length === 0 && <p className="stores-note">{storesTexts.empty}</p>}
      {state.stores.length > 0 && shown.length === 0 && <p className="stores-note" role="status">{storesTexts.nothingFound}</p>}
      {shown.length > 0 && <ul className="ck-list stores-list">
        {shown.map((store) => {
          const content = <span className="ck-row-main">
            <span className="ck-row-title">{store.name}</span>
            <span className="ck-row-meta">{storeMeta(store)}</span>
          </span>
          return <li key={store.id}>
            {state.can_merge
              ? <label className="ck-row stores-row"><input type="checkbox" checked={selected.includes(store.id)} onChange={() => onToggle(store.id)} />{content}</label>
              : <div className="ck-row stores-row">{content}</div>}
          </li>
        })}
      </ul>}
    </section>

    {state.can_merge && selected.length > 0 && <div className="stores-actions ck-action-bar">
      <button type="button" disabled={busy || selected.length < 2} onClick={() => onAsk(selected)}>
        {selected.length < 2 ? 'Выберите ещё магазин' : `Склеить выбранные · ${selected.length}`}</button>
    </div>}

    <Sheet open={ask !== null} onClose={() => { if (!busy) onCancel() }} title="Склеить магазины">
      {ask && <form className="stores-ask" onSubmit={(event) => { event.preventDefault(); onMerge() }}>
        <fieldset>
          <legend>Какое название оставить?</legend>
          {asked.map((store) => <label key={store.id} className="stores-choice">
            <input type="radio" name="stores-main" checked={ask.main === store.id} onChange={() => onMain(store.id)} />
            <span className="ck-row-main">
              <span className="ck-row-title">{store.name}</span>
              <span className="ck-row-meta">{storeMeta(store)}</span>
            </span>
          </label>)}
        </fieldset>
        <p className="stores-note">{storesTexts.sheetNote}</p>
        <div className="stores-ask-actions">
          <button type="submit" disabled={busy}>{busy ? 'Склеиваем…' : 'Склеить'}</button>
          <button type="button" className="ck-button-secondary" disabled={busy} onClick={onCancel}>Отмена</button>
        </div>
      </form>}
    </Sheet>
  </div>
}

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ok'; data: StoresState }

/** `/stores`: loads the state, merges and dismisses; every answer is the new state of the screen. */
export default function StoresPage() {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<number[]>([])
  const [ask, setAsk] = useState<MergeAsk | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string>()
  const [failure, setFailure] = useState<string>()
  const controller = useRef<AbortController | undefined>(undefined)
  useEffect(() => () => controller.current?.abort(), [])

  useEffect(() => {
    const current = new AbortController()
    void getStoresState({ signal: current.signal }).then((result) => {
      if (result.kind === 'ok') setLoad({ kind: 'ok', data: result.data })
      else if (result.kind === 'error') setLoad({ kind: 'error', message: errorMessage(result) })
    })
    return () => current.abort()
  }, [attempt])

  if (load.kind === 'loading') return <RequestState kind="loading" message="Загружаем магазины…" />
  if (load.kind === 'error') return <RequestState kind="error" message={load.message} onRetry={() => { setLoad({ kind: 'loading' }); setAttempt((value) => value + 1) }} />
  const state = load.data

  const send = async (request: (signal: AbortSignal) => Promise<LocalApiResult<StoresState>>, done: string) => {
    setBusy(true)
    setFailure(undefined)
    setNotice(undefined)
    const current = new AbortController()
    controller.current = current
    const result = await request(current.signal)
    if (current.signal.aborted || result.kind === 'aborted') return
    setBusy(false)
    if (result.kind === 'error') { setFailure(storesFailure(result)); return }
    setLoad({ kind: 'ok', data: result.data })
    setSelected([])
    setAsk(null)
    setNotice(done)
  }

  return <StoresView state={state} search={search} selected={selected} ask={ask} busy={busy} notice={notice} failure={failure}
    onSearch={setSearch}
    onToggle={(id) => setSelected((ids) => ids.includes(id) ? ids.filter((other) => other !== id) : [...ids, id])}
    onAsk={(ids) => { const main = defaultMain(pick(state, ids)); if (main !== undefined) setAsk({ ids, main }) }}
    onMain={(main) => setAsk((current) => current && { ...current, main })}
    onCancel={() => setAsk(null)}
    onMerge={() => {
      if (!ask) return
      const stores = pick(state, ask.ids)
      const main = stores.find((store) => store.id === ask.main)
      const merged = stores.filter((store) => store.id !== ask.main)
      if (!main || !merged.length) return
      void send((signal) => mergeStores(main.id, merged.map((store) => store.id), { signal }), mergedNotice(main, merged))
    }}
    onDismiss={(ids) => { void send((signal) => dismissStores(ids, { signal }), 'Больше не предложим.') }} />
}
