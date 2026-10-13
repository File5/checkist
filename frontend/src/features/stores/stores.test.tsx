import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { isStoresState } from '../../api/store-merges'
import type { StoresState } from '../../api/store-merges'
import { buildRoute, parseRoute } from '../../navigation'
import { defaultMain, filterStores, mergedNotice, pick, storeMeta, storesFailure, storesTexts } from './stores-state'
import { StoresView } from './StoresPage'
import type { StoresViewProps } from './StoresPage'

const noop = () => {}
const state: StoresState = {
  can_merge: true,
  suggestions: [{ source: 'similar', stores: [3, 4] }, { source: 'model', stores: [2, 1] }],
  stores: [
    { id: 1, name: 'Anthropic Claude', receipts_count: 2, aliases: [] },
    { id: 2, name: 'CLAUDE.AI SUBSCRIPTION', receipts_count: 4, aliases: ['Claude'] },
    { id: 3, name: 'MAGNUM', receipts_count: 21, aliases: [] },
    { id: 4, name: 'MAGNUM*ALMATY', receipts_count: 2, aliases: [] },
  ],
}
const view = (patch: Partial<StoresViewProps> = {}) => renderToStaticMarkup(<StoresView state={state} search="" selected={[]} ask={null} busy={false}
  onSearch={noop} onToggle={noop} onAsk={noop} onMain={noop} onCancel={noop} onMerge={noop} onDismiss={noop} {...patch} />)

describe('«Магазины» (Vitest/SSR, not browser visual acceptance)', () => {
  it('accepts the answer of the server', () => {
    expect(isStoresState(state)).toBe(true)
    expect(isStoresState({ ...state, suggestions: [{ source: 'similar', stores: [3] }] })).toBe(false)
    expect(isStoresState({ ...state, can_merge: 'yes' })).toBe(false)
  })

  it('words and rules of the screen', () => {
    expect(storeMeta(state.stores[1])).toBe('4\u00a0траты · также: Claude')
    expect(storeMeta(state.stores[2])).toBe('21\u00a0трата')
    expect(filterStores(state.stores, 'claude').map((store) => store.id)).toEqual([1, 2])
    expect(filterStores(state.stores, 'CLAUDE ').map((store) => store.id)).toEqual([1, 2])
    expect(filterStores(state.stores, '').length).toBe(4)
    expect(defaultMain(pick(state, [1, 2]))).toBe(2)
    expect(mergedNotice(state.stores[2], [state.stores[3]])).toBe('Склеено: MAGNUM*ALMATY → MAGNUM.')
    expect(storesFailure({ kind: 'error', reason: 'store_merge_conflict', status: 409 })).toBe(storesTexts.conflict)
    expect(storesFailure({ kind: 'error', reason: 'invalid_parameter', status: 400 })).toBe(storesTexts.changed)
  })

  it('a moderator sees the suggestions, the list with boxes and the merge bar', () => {
    const html = view({ selected: [3, 4] })
    expect(html).toContain('<h2 id="stores-suggestions-title">Похоже на одного получателя</h2>')
    expect(html).toContain('<span class="stores-names">MAGNUM · MAGNUM*ALMATY</span>')
    expect(html).toContain('<span class="ck-row-meta">4\u00a0траты · 2\u00a0траты · по мнению модели</span>')
    expect(html).toContain('<button type="button" class="ck-button-secondary">Не то</button>')
    expect(html).toContain('<label class="ck-row stores-row"><input type="checkbox" checked=""/>')
    expect(html).toContain('<div class="stores-actions ck-action-bar"><button type="button">Склеить выбранные · 2</button></div>')
    expect(view({ selected: [3] })).toContain('<button type="button" disabled="">Выберите ещё магазин</button>')
    expect(view()).not.toContain('stores-actions')
  })

  it('anyone else sees the list only', () => {
    const html = view({ state: { ...state, can_merge: false, suggestions: [] } })
    expect(html).not.toContain('Похоже на одного получателя')
    expect(html).not.toContain('type="checkbox"')
    expect(html).toContain(storesTexts.moderatorOnly)
  })

  it('asks which name to keep before the merge', () => {
    const html = view({ ask: { ids: [1, 2], main: 2 } })
    expect(html).toContain('<legend>Какое название оставить?</legend>')
    expect(html).toMatch(/<input type="radio" name="stores-main" checked=""\/><span class="ck-row-main"><span class="ck-row-title">CLAUDE\.AI SUBSCRIPTION<\/span>/)
    expect(html).toContain('<button type="submit">Склеить</button>')
    expect(view({ ask: { ids: [1, 2], main: 2 }, busy: true })).toContain('Склеиваем…')
  })

  it('finds what is searched and says when nothing is', () => {
    expect(view({ search: 'magnum' })).not.toContain('<span class="ck-row-title">Anthropic Claude</span>')
    expect(view({ search: 'нет такого' })).toContain(storesTexts.nothingFound)
    expect(view({ state: { can_merge: true, suggestions: [], stores: [] } })).toContain(storesTexts.empty)
  })

  it('lives at /stores', () => {
    expect(parseRoute('/stores')).toEqual({ kind: 'stores' })
    expect(buildRoute({ kind: 'stores' })).toBe('/stores')
  })
})
