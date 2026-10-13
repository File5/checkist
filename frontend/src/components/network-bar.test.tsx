import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import NetworkBar from './NetworkBar'
import { KEEP_SHOWN_MS, SHOW_AFTER_MS, watchActivity } from './network-bar'

/** A count of requests that the test moves by hand. */
function source() {
  let count = 0
  const listeners = new Set<(count: number) => void>()
  return {
    count: () => count,
    subscribe: (listener: (count: number) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set(next: number) { count = next; for (const listener of listeners) listener(count) },
    listeners,
  }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('when the network bar shows (components/network-bar.ts, fake timers)', () => {
  it('waits 200 ms: a fast answer never shows the bar', () => {
    const requests = source()
    const show = vi.fn()
    watchActivity(requests, show)
    requests.set(1)
    vi.advanceTimersByTime(SHOW_AFTER_MS - 1)
    requests.set(0)
    vi.advanceTimersByTime(5000)
    expect(show).not.toHaveBeenCalled()
  })

  it('shows after 200 ms of waiting and hides once nothing is on its way', () => {
    const requests = source()
    const show = vi.fn()
    watchActivity(requests, show)
    requests.set(1)
    vi.advanceTimersByTime(SHOW_AFTER_MS)
    expect(show.mock.calls).toEqual([[true]])
    requests.set(2)
    requests.set(1)
    vi.advanceTimersByTime(3000)
    expect(show.mock.calls).toEqual([[true]])
    requests.set(0)
    vi.advanceTimersByTime(0)
    expect(show.mock.calls).toEqual([[true], [false]])
  })

  it('keeps a bar it showed at least 400 ms: a request ending just after it does not blink it', () => {
    const requests = source()
    const show = vi.fn()
    watchActivity(requests, show)
    requests.set(1)
    vi.advanceTimersByTime(SHOW_AFTER_MS + 50)
    requests.set(0)
    vi.advanceTimersByTime(KEEP_SHOWN_MS - 51)
    expect(show.mock.calls).toEqual([[true]])
    vi.advanceTimersByTime(1)
    expect(show.mock.calls).toEqual([[true], [false]])
  })

  it('stays when a new request starts while it waits to go', () => {
    const requests = source()
    const show = vi.fn()
    watchActivity(requests, show)
    requests.set(1)
    vi.advanceTimersByTime(SHOW_AFTER_MS)
    requests.set(0)
    vi.advanceTimersByTime(100)
    requests.set(1)
    vi.advanceTimersByTime(5000)
    expect(show.mock.calls).toEqual([[true]])
    requests.set(0)
    vi.advanceTimersByTime(KEEP_SHOWN_MS)
    expect(show.mock.calls).toEqual([[true], [false]])
  })

  it('starts from the count it finds and leaves no timer and no listener when stopped', () => {
    const requests = source()
    requests.set(3)
    const show = vi.fn()
    const stop = watchActivity(requests, show)
    expect(requests.listeners.size).toBe(1)
    stop()
    expect(requests.listeners.size).toBe(0)
    vi.advanceTimersByTime(5000)
    expect(show).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('the network bar in the page (markup and rules, not rendering)', () => {
  const css = readFileSync(new URL('./NetworkBar.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

  it('draws nothing until it is shown', () => {
    expect(renderToStaticMarkup(<NetworkBar />)).toBe('')
  })

  it('pins 3 px to the very top under the safe area, in the colour of the main action, on its layer, never taking a touch', () => {
    const bar = css.slice(0, css.indexOf('@media'))
    expect(bar).toContain('position: fixed; top: env(safe-area-inset-top, 0px); right: 0; left: 0;')
    expect(bar).toContain('z-index: var(--ck-z-network-bar);')
    expect(bar).toContain('height: 3px;')
    expect(bar).toContain('background: var(--ck-primary);')
    expect(bar).toContain('pointer-events: none;')
  })

  it('moves only without reduced motion; with it the bar is a static full line', () => {
    const motion = '@media (prefers-reduced-motion: no-preference) {'
    expect(css.split(motion)).toHaveLength(2)
    const outside = css.slice(0, css.indexOf(motion))
    expect(outside).not.toMatch(/animation|transition|@keyframes/)
    expect(css.slice(css.indexOf(motion))).toContain('@keyframes ck-network-run')
  })
})
