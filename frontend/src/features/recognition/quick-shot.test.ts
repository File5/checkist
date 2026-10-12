import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearQuickShot, onQuickShot, peekQuickShot, setQuickShot } from './quick-shot'

const shot = (name: string) => new File(['x'], name, { type: 'image/jpeg' })

describe('quick shot hand-over', () => {
  afterEach(clearQuickShot)

  it('keeps the shot for the upload page that is not open yet', () => {
    const file = shot('a.jpg')
    expect(setQuickShot(file)).toBe(false)
    expect(peekQuickShot()).toBe(file)
  })

  it('gives a shot to the open upload page at once and keeps nothing stale', () => {
    const take = vi.fn()
    const stop = onQuickShot(take)
    const file = shot('b.jpg')
    expect(setQuickShot(file)).toBe(true)
    expect(take).toHaveBeenCalledWith(file)
    expect(peekQuickShot()).toBeUndefined()
    stop()
    expect(setQuickShot(shot('c.jpg'))).toBe(false)
    expect(take).toHaveBeenCalledTimes(1)
  })

  it('an old unsubscribe does not remove a newer page', () => {
    const first = vi.fn(), second = vi.fn()
    const stopFirst = onQuickShot(first)
    const stopSecond = onQuickShot(second)
    stopFirst()
    expect(setQuickShot(shot('d.jpg'))).toBe(true)
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
    stopSecond()
  })
})
