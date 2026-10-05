import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobDetail } from '../../api/recognition'
import { isJobDetail } from '../../api/recognition-schema'
import { publicFixture } from '../../api/recognition-test-support'
import type { LocalApiResult } from '../../api/types'
import { acceptJob, isActive } from './labels'
import { createPollingRequest } from './polling'
import type { PollEnvironment } from './polling'

function job(): JobDetail {
  const data = publicFixture('job-running.json')
  if (!isJobDetail(data)) throw new Error('Invalid fixture')
  return data
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes }); return { promise, resolve } }
const flush = async () => { await Promise.resolve(); await Promise.resolve() }
function visibility() {
  let hidden = false
  let listener = () => {}
  const unlisten = vi.fn()
  const env: PollEnvironment = {
    hidden: () => hidden, listen: (fn) => { listener = fn; return unlisten },
    later: (fn, delay) => setTimeout(fn, delay), clear: clearTimeout,
  }
  return { env, unlisten, change: (value: boolean) => { hidden = value; listener() } }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('polling lifetime with the public job fixture (Node, no browser)', () => {
  it('polls every 2 seconds and has one request in flight even during manual refresh', async () => {
    const pending = deferred<LocalApiResult<JobDetail>>()
    const load = vi.fn().mockResolvedValueOnce({ kind: 'ok', data: job() }).mockReturnValue(pending.promise)
    const request = createPollingRequest<JobDetail>(load, isActive, acceptJob)
    request.start(); await flush()
    await vi.advanceTimersByTimeAsync(1999); expect(load).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1); expect(load).toHaveBeenCalledTimes(2)
    request.refresh(); await vi.advanceTimersByTimeAsync(30000)
    expect(load).toHaveBeenCalledTimes(2)
    request.dispose()
  })
  it.each(['cancelled', 'succeeded', 'partial_succeeded', 'failed'] as const)('stops on %s including visibility changes', async (status) => {
    const view = visibility()
    const load = vi.fn().mockResolvedValueOnce({ kind: 'ok', data: job() }).mockResolvedValue({ kind: 'ok', data: { ...job(), status, version: 3 } })
    const request = createPollingRequest<JobDetail>(load, isActive, acceptJob, view.env)
    request.start(); await flush(); await vi.advanceTimersByTimeAsync(2000)
    view.change(true); view.change(false); await vi.advanceTimersByTimeAsync(60000)
    expect(load).toHaveBeenCalledTimes(2)
    request.dispose(); expect(view.unlisten).toHaveBeenCalledTimes(1)
  })
  it('continues through queued and cancel_requested until acknowledgement', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce({ kind: 'ok', data: { ...job(), status: 'queued' } })
      .mockResolvedValueOnce({ kind: 'ok', data: { ...job(), status: 'cancel_requested', version: 3 } })
      .mockResolvedValue({ kind: 'ok', data: { ...job(), status: 'cancelled', version: 4 } })
    const request = createPollingRequest<JobDetail>(load, isActive, acceptJob)
    request.start(); await flush(); await vi.advanceTimersByTimeAsync(4000)
    expect(request.getSnapshot()).toMatchObject({ kind: 'ok', data: { status: 'cancelled' } })
    await vi.advanceTimersByTimeAsync(60000); expect(load).toHaveBeenCalledTimes(3)
    request.dispose()
  })
  it('uses 10 seconds hidden, immediately refreshes on return and avoids overlap', async () => {
    const view = visibility()
    const pending = deferred<LocalApiResult<JobDetail>>()
    const load = vi.fn().mockResolvedValueOnce({ kind: 'ok', data: job() }).mockReturnValueOnce(pending.promise).mockResolvedValue({ kind: 'ok', data: job() })
    const request = createPollingRequest<JobDetail>(load, isActive, acceptJob, view.env)
    request.start(); await flush(); view.change(true)
    await vi.advanceTimersByTimeAsync(9999); expect(load).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1); expect(load).toHaveBeenCalledTimes(2)
    view.change(false); expect(load).toHaveBeenCalledTimes(2)
    pending.resolve({ kind: 'ok', data: job() }); await flush()
    view.change(true); view.change(false); await flush(); expect(load).toHaveBeenCalledTimes(3)
    request.dispose()
  })
  it('keeps the last snapshot and backs off 2/4/8/15/15 seconds, manual recovery clears the error', async () => {
    const original = job()
    const load = vi.fn().mockResolvedValueOnce({ kind: 'ok', data: original }).mockResolvedValue({ kind: 'error', reason: 'network' })
    const request = createPollingRequest<JobDetail>(load, isActive, acceptJob)
    request.start(); await flush(); await vi.advanceTimersByTimeAsync(2000)
    expect(request.getSnapshot()).toMatchObject({ kind: 'ok', data: original, refreshError: { reason: 'network' } })
    let calls = 2
    for (const delay of [2000, 4000, 8000, 15000, 15000]) {
      await vi.advanceTimersByTimeAsync(delay - 1); expect(load).toHaveBeenCalledTimes(calls)
      await vi.advanceTimersByTimeAsync(1); expect(load).toHaveBeenCalledTimes(++calls)
    }
    load.mockResolvedValue({ kind: 'ok', data: original }); request.refresh(); await flush()
    expect(request.getSnapshot()).toEqual({ kind: 'ok', data: original, refreshing: false })
    request.dispose()
  })
  it('requires manual retry for the initial error', async () => {
    const load = vi.fn().mockResolvedValueOnce({ kind: 'error', reason: 'network' }).mockResolvedValue({ kind: 'ok', data: job() })
    const request = createPollingRequest<JobDetail>(load, isActive)
    request.start(); await flush(); await vi.advanceTimersByTimeAsync(60000)
    expect(load).toHaveBeenCalledTimes(1); expect(request.getSnapshot()).toMatchObject({ kind: 'error' })
    request.refresh(); await flush(); expect(request.getSnapshot().kind).toBe('ok'); request.dispose()
  })
  it('rejects late reads after pause/mutation and ignores lower versions', async () => {
    const late = deferred<LocalApiResult<JobDetail>>()
    const signals: AbortSignal[] = []
    const load = vi.fn((signal: AbortSignal) => { signals.push(signal); return signals.length === 1 ? late.promise : Promise.resolve({ kind: 'ok' as const, data: job() }) })
    const request = createPollingRequest(load, isActive, acceptJob)
    request.start(); request.pause()
    expect(signals[0].aborted).toBe(true)
    const cancelled = { ...job(), status: 'cancelled' as const, version: 4 }
    request.setData(cancelled); request.resume(false)
    late.resolve({ kind: 'ok', data: job() }); await flush()
    expect(request.getSnapshot()).toMatchObject({ data: cancelled })
    request.refresh(); await flush(); expect(request.getSnapshot()).toMatchObject({ data: cancelled })
    request.dispose()
  })
  it('coalesces related updates during a read into one final read', async () => {
    const first = deferred<LocalApiResult<number>>()
    const load = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue({ kind: 'ok', data: 2 })
    const request = createPollingRequest<number>(load)
    request.start(); request.queueRefresh(); request.queueRefresh()
    first.resolve({ kind: 'ok', data: 1 }); await flush()
    expect(load).toHaveBeenCalledTimes(2); expect(request.getSnapshot()).toMatchObject({ data: 2 })
    request.dispose()
  })
  it('silences a disposed lifetime and can restart for StrictMode', async () => {
    const late = deferred<LocalApiResult<JobDetail>>()
    const load = vi.fn().mockReturnValueOnce(late.promise).mockResolvedValue({ kind: 'ok', data: job() })
    const request = createPollingRequest<JobDetail>(load, isActive)
    request.start(); request.dispose(); request.start(); await flush()
    late.resolve({ kind: 'error', reason: 'server' }); await flush()
    expect(request.getSnapshot()).toMatchObject({ kind: 'ok' })
    request.dispose(); expect(vi.getTimerCount()).toBe(0)
  })
  it('refreshes a page of active jobs once per tick, without detail reads', async () => {
    const load = vi.fn().mockResolvedValue({ kind: 'ok', data: [job(), { ...job(), id: 32 }] })
    const request = createPollingRequest<JobDetail[]>(load, (jobs) => jobs.some(isActive))
    request.start(); await flush(); await vi.advanceTimersByTimeAsync(2000)
    expect(load).toHaveBeenCalledTimes(2)
    request.dispose()
  })
})
