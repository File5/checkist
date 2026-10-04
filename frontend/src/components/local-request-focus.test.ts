import { describe, expect, it } from 'vitest'
import type { ApiResult } from '../api/types'
import { createCatalogRequest } from '../features/catalog/catalog-request'
import { createRequest } from '../features/product/state'
import { chooseLocalFocusTarget, createLocalRequestFocus } from './local-request-focus'
import type { LocalRequestPhase } from './local-request-focus'

// Model element identity/lifetime without a DOM or browser runner.
type Element = { name: string; local: boolean; available: boolean; retry?: boolean }
function setup(initial: LocalRequestPhase = 'ok') {
  const body: Element = { name: 'body', local: false, available: true }
  const other: Element = { name: 'other block', local: false, available: true }
  const result: Element = { name: 'local heading', local: true, available: true }
  const retry: Element = { name: 'retry', local: true, available: true, retry: true }
  const input: Element = { name: 'search input', local: true, available: true }
  const page: Element = { name: 'store pagination', local: true, available: true }
  const moves: Element[] = []
  let active = body
  const tracker = createLocalRequestFocus<Element>({
    active: () => active, inside: (element) => element.local, body: (element) => element === body,
    available: (element) => element.available, isRetry: (element) => Boolean(element.retry),
    result: () => result, retry: () => retry.available ? retry : undefined,
    focus: (element) => { moves.push(element); active = element; tracker.focusChanged(element) },
  })
  const focus = (element: Element) => { active = element; tracker.focusChanged(element) }
  const remove = (element: Element) => { element.available = false; if (active === element) active = body }
  tracker.update({ kind: initial })
  return { tracker, body, other, result, retry, input, page, moves, focus, remove, active: () => active }
}

describe('local request focus policy (Node, not browser acceptance)', () => {
  it('holds retry focus on the same heading during loading and after success', () => {
    const h = setup('error')
    h.focus(h.retry); h.remove(h.retry)
    h.tracker.update({ kind: 'loading' })
    expect(h.active()).toBe(h.result)
    h.tracker.update({ kind: 'ok' })
    expect(h.active()).toBe(h.result)
    expect(h.moves).toEqual([h.result]) // No redundant focus/announcement on success.
  })
  it('returns to the local retry button after a repeated error', () => {
    const h = setup('error')
    h.focus(h.retry); h.remove(h.retry)
    h.tracker.update({ kind: 'loading' })
    h.retry.available = true
    h.tracker.update({ kind: 'error' })
    expect(h.moves).toEqual([h.result, h.retry])
  })
  it('uses the result when the new error offers correction instead of retry', () => {
    const h = setup('error')
    h.focus(h.retry); h.remove(h.retry)
    h.tracker.update({ kind: 'loading' })
    h.tracker.update({ kind: 'error' })
    expect(h.active()).toBe(h.result)
    expect(h.moves).toEqual([h.result])
  })
  it.each(['next stores', 'previous stores', 'product page', 'history page', 'first page', 'reset filters'])('rescues the removed %s control inside its own results block', (name) => {
    const h = setup()
    h.page.name = name
    h.focus(h.page); h.remove(h.page)
    h.tracker.update({ kind: 'loading' })
    expect(h.active()).toBe(h.result)
    h.tracker.update({ kind: 'ok' })
    expect(h.moves).toEqual([h.result])
  })
  it('keeps a pagination control which remains available', () => {
    const h = setup()
    h.focus(h.page)
    h.tracker.update({ kind: 'loading' })
    h.tracker.update({ kind: 'ok' })
    expect(h.active()).toBe(h.page)
    expect(h.moves).toEqual([])
  })
  it('uses the result when the retained control becomes disabled at the boundary', () => {
    const h = setup()
    h.focus(h.page)
    h.tracker.update({ kind: 'loading' })
    h.page.available = false
    h.tracker.update({ kind: 'ok' })
    expect(h.active()).toBe(h.result)
  })
  it('does not capture focus moved to another block, even if it later becomes body', () => {
    const h = setup('error')
    h.focus(h.retry); h.remove(h.retry)
    h.tracker.update({ kind: 'loading' })
    h.focus(h.other)
    h.retry.available = true
    h.tracker.update({ kind: 'error' })
    h.focus(h.body)
    h.tracker.update({ kind: 'ok' })
    expect(h.active()).toBe(h.body)
    expect(h.moves).toEqual([h.result])
  })
  it('leaves a search input focused during search, success and errors', () => {
    const h = setup()
    h.focus(h.input)
    h.tracker.update({ kind: 'loading' })
    h.tracker.update({ kind: 'ok' })
    h.tracker.update({ kind: 'loading' })
    h.tracker.update({ kind: 'error' })
    expect(h.active()).toBe(h.input)
    expect(h.moves).toEqual([])
  })
  it('leaves an input focused when the user starts editing during retry', () => {
    const h = setup('error')
    h.focus(h.retry); h.remove(h.retry)
    h.tracker.update({ kind: 'loading' })
    h.focus(h.input)
    h.retry.available = true
    h.tracker.update({ kind: 'error' })
    expect(h.active()).toBe(h.input)
    expect(h.moves).toEqual([h.result])
  })
  it('rescues a removed draft action without a new request snapshot', () => {
    const h = setup()
    const state = { kind: 'ok' as const }
    h.tracker.update(state)
    h.focus(h.page); h.remove(h.page)
    h.tracker.update(state)
    expect(h.active()).toBe(h.result)
  })
  it('does not restore on initial loading or an unrelated result while focus is body', () => {
    const h = setup('loading')
    h.tracker.update({ kind: 'ok' })
    expect(h.active()).toBe(h.body)
    expect(h.moves).toEqual([])
  })
  it('supports a skipped loading commit when the response is immediate', () => {
    const h = setup('error')
    h.focus(h.retry); h.remove(h.retry)
    h.tracker.update({ kind: 'ok' })
    expect(h.active()).toBe(h.result)
  })
  it('does not restore after cancellation/unmount invalidates ownership', () => {
    const h = setup('error')
    h.focus(h.retry); h.remove(h.retry)
    h.tracker.update({ kind: 'loading' })
    h.tracker.invalidate()
    h.retry.available = true
    h.tracker.update({ kind: 'error' })
    expect(h.moves).toEqual([h.result])
  })
  it('rejects a stale generation even with lost body focus and an available retry', () => {
    expect(chooseLocalFocusTarget({ generation: 1, currentGeneration: 2, phase: 'error', retry: true,
      location: 'body', onResult: false, activeAvailable: true, retryAvailable: true })).toBeUndefined()
  })
})

function deferred() {
  let resolve!: (value: ApiResult<string>) => void
  const promise = new Promise<ApiResult<string>>((accept) => { resolve = accept })
  return { promise, resolve }
}
const flush = async () => { for (let turn = 0; turn < 5; ++turn) await Promise.resolve() }

describe.each(['catalog', 'product'] as const)('%s generation guard and focus together', (owner) => {
  const create = (load: (signal: AbortSignal) => Promise<ApiResult<string>>) => {
    if (owner === 'catalog') {
      const request = createCatalogRequest(load)
      return { ...request, run: request.start, dispose: request.stop }
    }
    return createRequest(load)
  }
  it.each(['ok', 'error', 'aborted'] as const)('never hands a late %s to focus restoration', async (kind) => {
    const old = deferred(), latest = deferred()
    let count = 0
    const request = create(() => ++count === 1 ? old.promise : latest.promise)
    const h = setup('error')
    request.subscribe(() => h.tracker.update(request.getSnapshot()))
    h.focus(h.retry); h.remove(h.retry)
    request.run(); await flush()
    request.run(); await flush()
    latest.resolve({ kind: 'ok', data: 'current' }); await flush()
    const movesBeforeLate = [...h.moves]
    h.retry.available = true
    old.resolve(kind === 'ok' ? { kind, data: 'old' } : kind === 'error' ? { kind, reason: 'network' } : { kind })
    await flush()
    expect(request.getSnapshot()).toEqual({ kind: 'ok', data: 'current' })
    expect(h.moves).toEqual(movesBeforeLate)
    expect(h.active()).toBe(h.result)
    request.dispose()
  })
  it('keeps an aborted current reply from returning focus to retry', async () => {
    const reply = deferred()
    const request = create(() => reply.promise)
    const h = setup('error')
    request.subscribe(() => h.tracker.update(request.getSnapshot()))
    h.focus(h.retry); h.remove(h.retry)
    request.run(); await flush()
    h.retry.available = true
    reply.resolve({ kind: 'aborted' }); await flush()
    expect(request.getSnapshot().kind).toBe('loading')
    expect(h.moves).toEqual([h.result])
    request.dispose()
  })
})
