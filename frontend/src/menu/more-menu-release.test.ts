import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MORE_MENU_CLOSED, PRESS_END_EVENTS, moreMenuStep } from './more-menu'
import type { MoreMenuEvent, MoreMenuState } from './more-menu'

const OPEN: MoreMenuState = { open: true, pressed: false }

/** What a browser sends, named as the menu is wired to hear it: the press on `.main-more`, the end of the
 * press on the document, the blur with no `relatedTarget`, the click on a link, on «Ещё», on an empty place
 * of the list. `pointerup-away` and `mouseup-away` happen outside of `.main-more`: only the document hears them.
 */
type Sent = 'pointerdown' | 'mousedown' | 'pointerup' | 'pointerup-away' | 'mouseup' | 'mouseup-away' | 'pointercancel'
  | 'blur' | 'click-link' | 'click-toggle' | 'click-list' | 'keydown-tab' | 'pointerdown-away'

const pressEnds: readonly string[] = PRESS_END_EVENTS

function heard(sent: Sent): MoreMenuEvent | null {
  if (sent === 'pointerdown' || sent === 'mousedown') return 'press'
  if (sent === 'blur') return 'focus-left'
  if (sent === 'click-link') return 'navigate'
  if (sent === 'click-toggle') return 'toggle'
  if (sent === 'click-list' || sent === 'keydown-tab') return 'release'
  if (sent === 'pointerdown-away') return 'outside'
  return pressEnds.includes(sent.replace('-away', '')) ? 'release' : null
}

const run = (sequence: Sent[], from: MoreMenuState = OPEN) => sequence.reduce<MoreMenuState[]>((seen, sent) => {
  const state = seen.at(-1) ?? from
  const event = heard(sent)
  return [...seen, event ? moreMenuStep(state, event) : state]
}, [])
const opens = (sequence: Sent[], from?: MoreMenuState) => run(sequence, from).map((state) => state.open)
const last = (sequence: Sent[], from?: MoreMenuState) => run(sequence, from).at(-1)

describe('a press inside of .main-more that brought no click (the reducer and the names of the events, no browser)', () => {
  it('is over when the pointer goes up outside: the next leave of the focus closes the list', () => {
    expect(opens(['pointerdown', 'pointerup-away', 'blur'])).toEqual([true, true, false])
    expect(last(['pointerdown', 'pointerup-away', 'blur'])).toEqual(MORE_MENU_CLOSED)
  })

  it('is over for a mouse that was dragged off the list, with the blur of the press already behind', () => {
    // Chrome: the press of a link moves the focus inside; the one of an empty place sends it to no one at once.
    expect(opens(['pointerdown', 'mousedown', 'pointerup-away', 'mouseup-away', 'blur'])).toEqual([true, true, true, true, false])
    const states = run(['pointerdown', 'mousedown', 'blur', 'pointerup-away', 'mouseup-away'])
    expect(states.map((state) => state.open)).toEqual([true, true, true, true, true])
    expect(states.at(-1)).toEqual(OPEN)
    expect(moreMenuStep(states.at(-1) ?? OPEN, 'focus-left')).toEqual(MORE_MENU_CLOSED)
  })

  it('is over when a finger moved inside of the list and was lifted: no tap, so no mouse events and no click', () => {
    // A touch keeps its pointer on the element it began on: pointerup comes to the list wherever the finger is.
    expect(last(['pointerdown', 'pointerup'])).toEqual(OPEN)
    expect(opens(['pointerdown', 'pointerup', 'blur'])).toEqual([true, true, false])
    expect(opens(['pointerdown', 'pointercancel', 'blur'])).toEqual([true, true, false])
  })

  it('is over after a click on an empty place of the list', () => {
    expect(opens(['pointerdown', 'mousedown', 'blur', 'pointerup', 'mouseup', 'click-list', 'blur']))
      .toEqual([true, true, true, true, true, true, false])
  })

  it.each(PRESS_END_EVENTS)('leaves nothing of the press after %s', (type) => {
    expect(last(['pointerdown', type])).toEqual(OPEN)
    expect(last(['pointerdown', 'mousedown', 'blur', type])).toEqual(OPEN)
  })
})

describe('a press of a link of the list still gets its click, whatever the order of the events', () => {
  it('a mouse: the blur comes with the mousedown, before the pointer goes up', () => {
    const states = run(['pointerdown', 'mousedown', 'blur', 'pointerup', 'mouseup', 'click-link'])
    expect(states.map((state) => state.open)).toEqual([true, true, true, true, true, false])
    expect(states.at(-1)).toEqual(MORE_MENU_CLOSED)
  })

  it('a touch in Safari: the blur comes after pointerup and before the click, with the mousedown of the tap', () => {
    const states = run(['pointerdown', 'pointerup', 'mousedown', 'blur', 'mouseup', 'click-link'])
    expect(states.map((state) => state.open)).toEqual([true, true, true, true, true, false])
    expect(states.at(-1)).toEqual(MORE_MENU_CLOSED)
  })

  it('no blur at all, and a blur right after pointerdown', () => {
    expect(opens(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click-link'])).toEqual([true, true, true, true, false])
    expect(opens(['pointerdown', 'blur', 'pointerup', 'mousedown', 'mouseup', 'click-link'])).toEqual([true, true, true, true, true, false])
  })

  it('a second press of «Ещё» closes the list once in both orders', () => {
    expect(last(['pointerdown', 'mousedown', 'blur', 'pointerup', 'mouseup', 'click-toggle'])).toEqual(MORE_MENU_CLOSED)
    expect(last(['pointerdown', 'pointerup', 'mousedown', 'blur', 'mouseup', 'click-toggle'])).toEqual(MORE_MENU_CLOSED)
  })

  it('a press of «Ещё» opens a closed list in both orders', () => {
    expect(last(['pointerdown', 'mousedown', 'blur', 'pointerup', 'mouseup', 'click-toggle'], MORE_MENU_CLOSED)).toEqual(OPEN)
    expect(last(['pointerdown', 'pointerup', 'mousedown', 'blur', 'mouseup', 'click-toggle'], MORE_MENU_CLOSED)).toEqual(OPEN)
  })

  it('a touch outside and Tab out of the list close it as before', () => {
    expect(last(['pointerdown-away'])).toEqual(MORE_MENU_CLOSED)
    expect(last(['keydown-tab', 'blur'])).toEqual(MORE_MENU_CLOSED)
    expect(last(['pointerdown', 'blur', 'pointerup-away', 'pointerdown-away'])).toEqual(MORE_MENU_CLOSED)
  })
})

describe('wiring of the end of a press in MainMenu (the text of the file: there is no DOM in the tests)', () => {
  const source = readFileSync(new URL('./MainMenu.tsx', import.meta.url), 'utf8')

  it('names the end of the pointer, of the mouse button and a cancelled touch', () => {
    expect([...PRESS_END_EVENTS].sort()).toEqual(['mouseup', 'pointercancel', 'pointerup'])
  })

  it('hears them on the document, in the capture phase, and takes the listeners away', () => {
    expect(source).toContain("const onPressEnd = () => dispatch('release')")
    expect(source).toContain('for (const type of PRESS_END_EVENTS) document.addEventListener(type, onPressEnd, true)')
    expect(source).toContain('for (const type of PRESS_END_EVENTS) document.removeEventListener(type, onPressEnd, true)')
  })

  it('does not wait for the click with a timer and does not end the press by a lost capture', () => {
    // lostpointercapture has come late in some engines: between the mousedown of a tap and its blur it would hide the list.
    expect(source).not.toMatch(/setTimeout|requestAnimationFrame|lostpointercapture/i)
  })
})
