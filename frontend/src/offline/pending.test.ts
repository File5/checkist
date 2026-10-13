import { describe, expect, it, vi } from 'vitest'
import type { ManualSpendInput, Receipt } from '../api/receipts'
import { publicFixture } from '../api/recognition-test-support'
import type { LocalApiResult, Page } from '../api/types'
import { ATTEMPT_WINDOW_MS, findSaved, isNetworkFailure, isSameSpend, memoryStore, newPending, ownSpends, spendAmount, spendCents, syncPending } from './pending'
import type { SyncDeps } from './pending'
import { draftFromPending, outcomeNote } from './pending-store'

const T0 = new Date('2026-10-12T10:00:00Z')
const body: ManualSpendInput = { currency: 'KZT', purchased_on: '2026-10-12', store_name: null, note: 'кофе', category: 2, total: '450', lines: [] }
const photo = publicFixture('receipt.json') as Receipt
const saved = (patch: Partial<Receipt> = {}): Receipt => ({
  ...photo, id: 500, owner: 'anna', source: 'manual', store: null, note: 'кофе', currency: 'KZT', purchased_on: '2026-10-12',
  total: '450.00', lines_count: 1, created_at: '2026-10-12T10:00:20Z', ...patch,
})
const pageOf = (results: Receipt[]): LocalApiResult<Page<Receipt>> => ({ kind: 'ok', data: { results, count: results.length, page: 1, page_size: 200, pages: 1 } })
const created = (id: number): LocalApiResult<Receipt> => ({ kind: 'ok', data: saved({ id }) })

function deps(store: ReturnType<typeof memoryStore>, patch: Partial<SyncDeps> = {}): SyncDeps {
  return {
    store, owner: 'anna', now: () => new Date('2026-10-12T12:00:00Z'), describe: (failure) => `refused:${failure.reason}`,
    send: vi.fn(async () => created(600)), recent: vi.fn(async () => pageOf([])), ...patch,
  }
}

describe('pending spend rules', () => {
  it('a spend saved without network remembers that attempt', () => {
    const spend = newPending(body, 'anna', T0, 'id-1')
    expect(spend).toEqual({ id: 'id-1', owner: 'anna', body, createdAt: T0.toISOString(), attempts: [T0.toISOString()], error: null })
    expect(newPending(body, 'anna').id).not.toBe(newPending(body, 'anna').id)
  })

  it('only network and timeout keep a spend on the phone', () => {
    expect(isNetworkFailure({ kind: 'error', reason: 'network' })).toBe(true)
    expect(isNetworkFailure({ kind: 'error', reason: 'timeout' })).toBe(true)
    expect(isNetworkFailure({ kind: 'error', reason: 'invalid_parameter', status: 400 })).toBe(false)
    expect(isNetworkFailure({ kind: 'error', reason: 'server', status: 500 })).toBe(false)
    expect(isNetworkFailure({ kind: 'aborted' })).toBe(false)
    expect(isNetworkFailure({ kind: 'ok', data: null })).toBe(false)
  })

  it('counts the total the server will store', () => {
    expect(spendCents(body)).toBe(45000)
    expect(spendCents({ ...body, total: '12.5' })).toBe(1250)
    expect(spendCents({ ...body, total: undefined, lines: [{ name: 'a', amount: '1.10' }, { name: 'b', amount: '2' }] })).toBe(310)
    expect(spendAmount({ ...body, total: '0.05' })).toBe('0.05')
    expect(spendCents({ ...body, total: 'x' })).toBeUndefined()
  })

  it('recognizes the same spend saved by a lost answer', () => {
    const spend = newPending(body, 'anna', T0)
    expect(isSameSpend(spend, saved())).toBe(true)
    expect(isSameSpend(spend, saved({ owner: 'boris' }))).toBe(false)
    expect(isSameSpend(spend, saved({ source: 'photo' }))).toBe(false)
    expect(isSameSpend(spend, saved({ total: '451.00' }))).toBe(false)
    expect(isSameSpend(spend, saved({ currency: 'RUB' }))).toBe(false)
    expect(isSameSpend(spend, saved({ purchased_on: '2026-10-11' }))).toBe(false)
    expect(isSameSpend(spend, saved({ note: 'чай' }))).toBe(false)
    expect(isSameSpend(spend, saved({ lines_count: 2 }))).toBe(false)
    expect(isSameSpend(spend, saved({ store: { ...photo.store!, name: 'Кафе' } }))).toBe(false)
    expect(isSameSpend({ ...spend, body: { ...body, store_name: 'Кафе' } }, saved({ store: { ...photo.store!, name: 'Кафе' } }))).toBe(true)
    const late = new Date(T0.getTime() + ATTEMPT_WINDOW_MS + 1000).toISOString()
    expect(isSameSpend(spend, saved({ created_at: late }))).toBe(false)
    expect(isSameSpend({ ...spend, attempts: [] }, saved())).toBe(false)
  })

  it('a receipt matched once is not matched again', () => {
    const spend = newPending(body, 'anna', T0)
    expect(findSaved(spend, [saved()], new Set([500]))).toBeUndefined()
    expect(findSaved(spend, [saved(), saved({ id: 501 })], new Set([500]))?.id).toBe(501)
  })

  it('each person sees only their own spends, oldest first', () => {
    const a = newPending(body, 'anna', new Date('2026-10-12T10:00:00Z'), 'a')
    const b = newPending(body, 'boris', new Date('2026-10-12T09:00:00Z'), 'b')
    const c = newPending(body, 'anna', new Date('2026-10-12T08:00:00Z'), 'c')
    expect(ownSpends([a, b, c], 'anna').map((spend) => spend.id)).toEqual(['c', 'a'])
  })

  it('the form opens with a waiting spend; a removed category is dropped', () => {
    const draft = draftFromPending({ ...body, total: '450.00', category: 9 }, [{ id: 2 }])
    expect(draft).toMatchObject({ amount: '450', currency: 'KZT', category: null, date: '2026-10-12', place: '', note: 'кофе', lines: [] })
    const itemized = draftFromPending({ ...body, total: undefined, lines: [{ name: 'Хлеб', amount: '1.50', category: 2 }] }, [{ id: 2 }])
    expect(itemized.amount).toBe('')
    expect(itemized.lines).toMatchObject([{ name: 'Хлеб', amount: '1.50', category: 2 }])
  })
})

describe('syncPending', () => {
  it('sends the spends one by one and removes each on 201', async () => {
    const store = memoryStore([{ ...newPending(body, 'anna', T0, 'one'), attempts: [] }, { ...newPending({ ...body, total: '5' }, 'anna', T0, 'two'), attempts: [] }])
    const send = vi.fn(async () => created(600))
    const outcome = await syncPending(deps(store, { send }))
    expect(outcome).toEqual({ sent: 2, matched: 0, refused: 0 })
    expect(send).toHaveBeenCalledTimes(2)
    expect(store.items.size).toBe(0)
  })

  it('does not resend a spend the server already saved', async () => {
    const store = memoryStore([newPending(body, 'anna', T0, 'one')])
    const send = vi.fn(async () => created(600))
    const outcome = await syncPending(deps(store, { send, recent: async () => pageOf([saved()]) }))
    expect(outcome).toEqual({ sent: 0, matched: 1, refused: 0 })
    expect(send).not.toHaveBeenCalled()
    expect(store.items.size).toBe(0)
  })

  it('two identical spends: the receipt of the first is not taken for the second', async () => {
    const store = memoryStore([newPending(body, 'anna', T0, 'one'), newPending(body, 'anna', new Date(T0.getTime() + 1000), 'two')])
    const send = vi.fn(async () => created(700))
    // The first was saved by its lost answer; the second never reached the server.
    const outcome = await syncPending(deps(store, { send, recent: async () => pageOf([saved()]) }))
    expect(outcome).toEqual({ sent: 1, matched: 1, refused: 0 })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('stops without network and keeps everything', async () => {
    const store = memoryStore([{ ...newPending(body, 'anna', T0, 'one'), attempts: [] }, { ...newPending(body, 'anna', T0, 'two'), attempts: [] }])
    const send = vi.fn(async (): Promise<LocalApiResult<Receipt>> => ({ kind: 'error', reason: 'network' }))
    const outcome = await syncPending(deps(store, { send }))
    expect(outcome).toEqual({ sent: 0, matched: 0, refused: 0, stopped: 'network' })
    expect(send).toHaveBeenCalledTimes(1)
    expect(store.items.size).toBe(2)
    // The failed send is remembered: the next run checks the server first.
    expect(store.items.get('one')!.attempts).toEqual(['2026-10-12T12:00:00.000Z'])
  })

  it('a check that cannot reach the server stops the run before any resend', async () => {
    const store = memoryStore([newPending(body, 'anna', T0, 'one')])
    const send = vi.fn(async () => created(600))
    const outcome = await syncPending(deps(store, { send, recent: async () => ({ kind: 'error', reason: 'timeout' }) }))
    expect(outcome.stopped).toBe('network')
    expect(send).not.toHaveBeenCalled()
  })

  it('a refusal keeps the spend with its reason and goes on', async () => {
    const store = memoryStore([{ ...newPending(body, 'anna', T0, 'one'), attempts: [] }, { ...newPending(body, 'anna', new Date(T0.getTime() + 1), 'two'), attempts: [] }])
    const send = vi.fn<SyncDeps['send']>()
      .mockResolvedValueOnce({ kind: 'error', reason: 'invalid_parameter', status: 400, fields: ['category'] })
      .mockResolvedValueOnce(created(601))
    const outcome = await syncPending(deps(store, { send }))
    expect(outcome).toEqual({ sent: 1, matched: 0, refused: 1 })
    expect([...store.items.values()]).toMatchObject([{ id: 'one', error: 'refused:invalid_parameter' }])
  })

  it('an ended session stops the run', async () => {
    const store = memoryStore([{ ...newPending(body, 'anna', T0, 'one'), attempts: [] }])
    const outcome = await syncPending(deps(store, { send: async () => ({ kind: 'aborted' }) }))
    expect(outcome.stopped).toBe('aborted')
    expect(store.items.size).toBe(1)
  })

  it('never sends the spends of another person', async () => {
    const store = memoryStore([{ ...newPending(body, 'boris', T0, 'b'), attempts: [] }])
    const send = vi.fn(async () => created(600))
    expect(await syncPending(deps(store, { send }))).toEqual({ sent: 0, matched: 0, refused: 0 })
    expect(send).not.toHaveBeenCalled()
    expect(store.items.has('b')).toBe(true)
  })

  it('says how the run ended', () => {
    expect(outcomeNote({ sent: 0, matched: 0, refused: 0, stopped: 'network' })).toMatch(/недоступен/)
    expect(outcomeNote({ sent: 1, matched: 0, refused: 1 })).toMatch(/исправьте или удалите/)
    expect(outcomeNote({ sent: 2, matched: 1, refused: 0 })).toBe('Отправлено трат: 3.')
    expect(outcomeNote({ sent: 0, matched: 0, refused: 0 })).toBeUndefined()
  })
})
