import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MORE_MENU_CLOSED, moreMenuReducer, moreMenuStep } from './more-menu'
import type { MoreMenuAction, MoreMenuEvent, MoreMenuState } from './more-menu'

const OPEN: MoreMenuState = { open: true, pressed: false }

/** The state after every event of a sequence, in the order a browser sends them. */
const run = (events: MoreMenuEvent[], from: MoreMenuState = MORE_MENU_CLOSED) =>
  events.reduce<MoreMenuState[]>((seen, event) => [...seen, moreMenuStep(seen.at(-1) ?? from, event)], [])
const opens = (events: MoreMenuEvent[], from?: MoreMenuState) => run(events, from).map((state) => state.open)

describe('list behind «Ещё» and a press inside of .main-more (the reducer only, no browser)', () => {
  it('stays open for the click when Safari takes the focus away with no relatedTarget', () => {
    // «Ещё» has the focus (keyboard, VoiceOver); a link of the list is pressed: pointerdown, blur to no one, click.
    const states = run(['toggle', 'press', 'focus-left', 'navigate'])
    expect(states.map((state) => state.open)).toEqual([true, true, true, false])
    // The click finds the list drawn, the transition happens; nothing of the press is left afterwards.
    expect(states.at(-1)).toEqual(MORE_MENU_CLOSED)
  })

  it('survives both reports of one touch: pointerdown, later mousedown and the blur it causes', () => {
    expect(opens(['press', 'press', 'focus-left', 'navigate'], OPEN)).toEqual([true, true, true, false])
    expect(opens(['press', 'focus-left', 'focus-left', 'navigate'], OPEN)).toEqual([true, true, true, false])
  })

  it('is still closed by the focus that left with no relatedTarget and no press inside', () => {
    expect(moreMenuStep(OPEN, 'focus-left')).toEqual(MORE_MENU_CLOSED)
    expect(opens(['toggle', 'focus-left'])).toEqual([true, false])
  })

  it('is closed once by a second press of «Ещё», not closed by the blur and opened again by the click', () => {
    const states = run(['toggle', 'press', 'focus-left', 'toggle'])
    expect(states.map((state) => state.open)).toEqual([true, true, true, false])
    expect(states.at(-1)).toEqual(MORE_MENU_CLOSED)
    // Where the focus stays on the button there is no blur at all: the same single toggle.
    expect(opens(['toggle', 'press', 'toggle'])).toEqual([true, true, false])
  })

  it('is opened by a press of «Ещё» whatever the focus does in between', () => {
    expect(opens(['press', 'focus-left', 'toggle'])).toEqual([false, false, true])
    expect(run(['press', 'toggle']).at(-1)).toEqual(OPEN)
  })

  it.each<MoreMenuEvent>(['toggle', 'escape', 'outside', 'navigate', 'release'])('forgets the press after %s', (event) => {
    expect(moreMenuStep({ open: true, pressed: true }, event).pressed).toBe(false)
    expect(moreMenuStep({ open: false, pressed: true }, event).pressed).toBe(false)
  })

  it('is closed by Tab out of the list after a press that brought no click', () => {
    // A cancelled touch (scroll) or a key ends the press; the next blur is a real leave.
    expect(opens(['press', 'release', 'focus-left'], OPEN)).toEqual([true, true, false])
    // A press that slid off the list: the focus is gone, the list waits; a touch outside closes it as before.
    expect(opens(['press', 'focus-left', 'outside'], OPEN)).toEqual([true, true, false])
    expect(opens(['press', 'focus-left', 'escape'], OPEN)).toEqual([true, true, false])
  })

  it('never opens the list by a press, a release or the focus', () => {
    for (const event of ['press', 'release', 'focus-left'] as MoreMenuEvent[]) {
      expect(moreMenuStep(MORE_MENU_CLOSED, event).open, event).toBe(false)
      expect(moreMenuStep({ open: false, pressed: true }, event).open, event).toBe(false)
    }
  })

  it('agrees with the plain reducer while no press is under way', () => {
    for (const action of ['toggle', 'escape', 'outside', 'navigate', 'focus-left'] as MoreMenuAction[]) {
      for (const open of [false, true]) {
        expect(moreMenuStep({ open, pressed: false }, action), `${action} ${open}`).toEqual({ open: moreMenuReducer(open, action), pressed: false })
      }
    }
  })

  it('keeps the same state object when nothing changes, so a key or a repeated press redraws nothing', () => {
    const pressed: MoreMenuState = { open: true, pressed: true }
    expect(moreMenuStep(OPEN, 'release')).toBe(OPEN)
    expect(moreMenuStep(pressed, 'press')).toBe(pressed)
    expect(moreMenuStep(pressed, 'focus-left')).toBe(pressed)
    expect(moreMenuStep(MORE_MENU_CLOSED, 'escape')).toBe(MORE_MENU_CLOSED)
  })
})

describe('wiring of the press in MainMenu (the text of the file: there is no DOM in the tests)', () => {
  const source = readFileSync(new URL('./MainMenu.tsx', import.meta.url), 'utf8')
  const wrapper = source.match(/<div className="main-more"[^>]*>/)?.[0] ?? ''

  it('hears the press on the wrapper of the button and the list, before the blur', () => {
    expect(wrapper).toContain('onPointerDown={onPress}')
    expect(wrapper).toContain('onMouseDown={onPress}')
    expect(wrapper).toContain('onPointerCancel={onRelease}')
    expect(wrapper).toContain('onBlur={onBlur}')
    expect(source).toContain("const onPress = () => dispatch('press')")
  })

  it('lets the reducer decide about the blur and does not stop the press from focusing', () => {
    expect(source).toContain('useReducer(moreMenuStep, MORE_MENU_CLOSED)')
    expect(source).toContain("if (!event.currentTarget.contains(event.relatedTarget)) dispatch('focus-left')")
    expect(source).not.toContain('preventDefault')
    expect(source).not.toMatch(/setTimeout|requestAnimationFrame/)
  })
})
