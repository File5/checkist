import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalApiResult } from '../../api/types'
import { createUndoDelete, hiddenIds, swipeEnd, UNDO_MS } from './undo-delete'

const small = { id: 7, title: 'Small' }
const cafe = { id: 8, title: 'Кофейня у дома' }

describe('«Удалено · Отменить»: the DELETE waits for the undo time (2026-10-13)', () => {
  let send: ReturnType<typeof vi.fn<(id: number) => Promise<LocalApiResult<null>>>>
  beforeEach(() => {
    vi.useFakeTimers()
    send = vi.fn(async () => ({ kind: 'ok', data: null }) as LocalApiResult<null>)
  })
  afterEach(() => { vi.useRealTimers() })

  it('hides the row at once and sends nothing before the time is over', async () => {
    const prepare = vi.fn()
    const store = createUndoDelete(send, { prepare })
    store.schedule(small)
    expect(prepare).toHaveBeenCalledOnce()
    expect([...hiddenIds(store.getSnapshot())]).toEqual([7])
    await vi.advanceTimersByTimeAsync(UNDO_MS - 1)
    expect(send).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(send).toHaveBeenCalledExactlyOnceWith(7)
    expect(store.getSnapshot()).toEqual({ pending: null, gone: [7], failure: null })
  })

  it('«Отменить» shows the row again and never reaches the server', async () => {
    const store = createUndoDelete(send)
    store.schedule(small)
    store.undo()
    await vi.advanceTimersByTimeAsync(UNDO_MS * 2)
    expect(send).not.toHaveBeenCalled()
    expect([...hiddenIds(store.getSnapshot())]).toEqual([])
  })

  it('sends at once when the screen is left (flush), and only once', async () => {
    const store = createUndoDelete(send)
    store.schedule(small)
    store.flush()
    store.flush()
    await vi.advanceTimersByTimeAsync(UNDO_MS)
    expect(send).toHaveBeenCalledExactlyOnceWith(7)
  })

  it('a second deletion sends the first one: one waits at a time', async () => {
    const store = createUndoDelete(send)
    store.schedule(small)
    store.schedule(cafe)
    expect(send).toHaveBeenCalledExactlyOnceWith(7)
    expect(store.getSnapshot().pending).toEqual(cafe)
    expect([...hiddenIds(store.getSnapshot())].sort()).toEqual([7, 8])
  })

  it('a refused DELETE brings the row back with the reason; a missing spend counts as deleted', async () => {
    send.mockResolvedValueOnce({ kind: 'error', reason: 'network' }).mockResolvedValueOnce({ kind: 'error', reason: 'not_found', status: 404 })
    const store = createUndoDelete(send)
    store.schedule(small)
    store.flush()
    await vi.waitFor(() => expect(store.getSnapshot().failure).not.toBeNull())
    expect(store.getSnapshot()).toEqual({ pending: null, gone: [], failure: { id: 7, message: 'Не удалось связаться с сервером. Проверьте соединение и повторите попытку.' } })
    store.schedule(cafe)
    expect(store.getSnapshot().failure).toBeNull()
    store.flush()
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getSnapshot()).toEqual({ pending: null, gone: [8], failure: null })
  })

  it('stops the time while the bar has the focus and starts it again after', async () => {
    const store = createUndoDelete(send)
    store.schedule(small)
    store.hold()
    await vi.advanceTimersByTimeAsync(UNDO_MS * 3)
    expect(send).not.toHaveBeenCalled()
    store.release()
    await vi.advanceTimersByTimeAsync(UNDO_MS)
    expect(send).toHaveBeenCalledOnce()
  })

  it('tells its listeners about every change', () => {
    const store = createUndoDelete(send)
    const listener = vi.fn()
    const stop = store.subscribe(listener)
    store.schedule(small)
    store.undo()
    stop()
    store.schedule(cafe)
    expect(listener).toHaveBeenCalledTimes(2)
  })
})

describe('where a swiped row lets go', () => {
  it('deletes past 40 % of the row (at least 160 px), stays open past half of the button, else goes back', () => {
    expect(swipeEnd(-200, 500)).toBe('delete')
    expect(swipeEnd(-199, 500)).toBe('open')
    expect(swipeEnd(-160, 390)).toBe('delete')
    expect(swipeEnd(-159, 390)).toBe('open')
    expect(swipeEnd(-159, 300)).toBe('open')
    expect(swipeEnd(-160, 300)).toBe('delete')
    expect(swipeEnd(-48, 390)).toBe('open')
    expect(swipeEnd(-47, 390)).toBe('close')
    expect(swipeEnd(0, 390)).toBe('close')
  })
})
