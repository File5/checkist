import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { begin, end, inFlightCount, subscribe } from './activity'
import { requestJson } from './http'

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null
const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { vi.unstubAllGlobals(); while (inFlightCount() > 0) end() })

/** A fetch answered when the test says so. */
function held() {
  let answer!: (response: Response) => void
  fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { answer = resolve }))
  return (body: unknown = {}, status = 200) => answer(new Response(JSON.stringify(body), { status }))
}

describe('the count of requests on their way (api/activity.ts)', () => {
  it('counts every begin until its end and tells each listener the new count', () => {
    const heard: number[] = []
    const stop = subscribe((count) => heard.push(count))
    begin()
    begin()
    end()
    expect(inFlightCount()).toBe(1)
    end()
    expect(inFlightCount()).toBe(0)
    expect(heard).toEqual([1, 2, 1, 0])
    stop()
    begin()
    expect(heard).toEqual([1, 2, 1, 0])
    end()
  })

  it('never goes below zero: an end without its begin changes nothing and is not heard', () => {
    const heard: number[] = []
    const stop = subscribe((count) => heard.push(count))
    end()
    expect(inFlightCount()).toBe(0)
    expect(heard).toEqual([])
    stop()
  })
})

describe('the transport counts its requests (api/http.ts sendJson)', () => {
  it('counts a request from before its fetch to its answer', async () => {
    const answer = held()
    const result = requestJson('dashboard/', {}, isObject)
    expect(inFlightCount()).toBe(1)
    answer({ ok: true })
    expect(await result).toEqual({ kind: 'ok', data: { ok: true } })
    expect(inFlightCount()).toBe(0)
  })

  it('ends a failed, a refused and an aborted request too', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('offline'))
    expect((await requestJson('dashboard/', {}, isObject)).kind).toBe('error')
    expect(inFlightCount()).toBe(0)

    const refuse = held()
    const refused = requestJson('dashboard/', {}, isObject)
    refuse({ error: { code: 'not_found', message: 'Нет.' } }, 404)
    expect((await refused).kind).toBe('error')
    expect(inFlightCount()).toBe(0)

    held()
    const controller = new AbortController()
    const aborted = requestJson('dashboard/', {}, isObject, { signal: controller.signal })
    expect(inFlightCount()).toBe(1)
    controller.abort()
    expect((await aborted).kind).toBe('aborted')
    expect(inFlightCount()).toBe(0)
  })

  it('does not count a request that outlives the page (keepalive): nobody waits for it on the screen', async () => {
    const answer = held()
    const result = requestJson('receipts/5/', {}, isObject, {}, { method: 'DELETE', keepalive: true })
    expect(inFlightCount()).toBe(0)
    answer({})
    await result
    expect(inFlightCount()).toBe(0)
  })

  it('does not count a request whose signal was aborted before it started', async () => {
    const controller = new AbortController()
    controller.abort()
    expect((await requestJson('dashboard/', {}, isObject, { signal: controller.signal })).kind).toBe('aborted')
    expect(inFlightCount()).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
