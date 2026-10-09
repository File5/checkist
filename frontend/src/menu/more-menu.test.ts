import { describe, expect, it } from 'vitest'
import { moreMenuReducer } from './more-menu'
import type { MoreMenuAction } from './more-menu'

const closing: MoreMenuAction[] = ['escape', 'outside', 'navigate', 'focus-left']

describe('list behind «Ещё» (the reducer only, no browser)', () => {
  it('is opened and closed by the button', () => {
    expect(moreMenuReducer(false, 'toggle')).toBe(true)
    expect(moreMenuReducer(true, 'toggle')).toBe(false)
  })

  it.each(closing)('is closed by %s', (action) => {
    expect(moreMenuReducer(true, action)).toBe(false)
  })

  it.each(closing)('is never opened by %s', (action) => {
    expect(moreMenuReducer(false, action)).toBe(false)
  })

  it('goes through a whole visit: open, a link, open again, Esc', () => {
    const actions: MoreMenuAction[] = ['toggle', 'navigate', 'toggle', 'escape', 'focus-left']
    const states = actions.reduce<boolean[]>((seen, action) => [...seen, moreMenuReducer(seen.at(-1) ?? false, action)], [])
    expect(states).toEqual([true, false, true, false, false])
  })
})
