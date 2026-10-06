import { describe, expect, it } from 'vitest'
import { createLocalRequestFocus, focusOwnerAttribute, insideLocalBlock } from '../../components/local-request-focus'
import { reviewFocusTarget } from './review-actions'

// The crop list block (RequestBlock) and the confirmation of one crop, modelled without a DOM or browser runner.
type Node = { name: string; parent: Node | null; owner: boolean; connected: boolean; disabled: boolean; contains: (node: Node | null) => boolean; closest: (selector: string) => Node | null }
function node(name: string, parent: Node | null, owner = false): Node {
  const self: Node = {
    name, parent, owner, connected: true, disabled: false,
    contains: (other) => { for (let at = other; at; at = at.parent) if (at === self) return true; return false },
    closest: (selector) => {
      if (selector !== `[${focusOwnerAttribute}]`) throw new Error(selector)
      for (let at: Node | null = self; at; at = at.parent) if (at.owner) return at
      return null
    },
  }
  return self
}

/** `owned: false` is the markup before the fix: the card did not own its focus. */
function setup(owned: boolean) {
  const body = node('body', null)
  const block = node('crops block', body)
  const heading = node('h2 «Вырезки чеков»', block)
  const refresh = node('«Повторить обновление»', block)
  const card = node('crop card', block, owned)
  const message = node('message of the card', card)
  const button = node('«Подтвердить и сохранить чек»', card)
  const jobAction = node('«Повторить обработку» of the job block', body)
  const moves: Node[] = []
  let active = body
  const tracker = createLocalRequestFocus<Node>({
    active: () => active, inside: (element) => insideLocalBlock(block, element), body: (element) => element === body,
    available: (element) => element.connected && !element.disabled, isRetry: (element) => element === refresh,
    result: () => heading, retry: () => undefined,
    focus: (element) => { moves.push(element); active = element; tracker.focusChanged(element) },
  })
  const focus = (element: Node) => { active = element; tracker.focusChanged(element) }
  /** Every commit of the block hands a new snapshot of the same phase: pause(), the answer, a reread. */
  const commit = () => tracker.update({ kind: 'ok' })
  /** useReviewFocus after the answer, with the same reading of the document. */
  const answer = (pressed: Node) => {
    const target = reviewFocusTarget(active === body ? 'body' : active === pressed ? 'pressed' : 'elsewhere', pressed.connected && !pressed.disabled)
    if (target === 'pressed') focus(pressed)
    else if (target === 'result') focus(message)
    return target
  }
  commit()
  return { body, heading, refresh, message, button, jobAction, moves, focus, commit, answer, blur: () => { active = body }, active: () => active }
}

describe('focus of a crop confirmation inside the crop list block (Node, not browser acceptance)', () => {
  it.each(['stays on the disabled button', 'falls to body'])('reproduces the defect without a focus owner: a disabled pressed button hands focus to the block heading (%s)', (browser) => {
    const h = setup(false)
    h.focus(h.button)
    h.button.disabled = true
    if (browser === 'falls to body') h.blur()
    h.commit()
    expect(h.moves).toEqual([h.heading])
    h.button.disabled = false
    h.commit()
    // The heading is neither body nor the pressed button: the answer left focus at the top of the list.
    expect(h.answer(h.button)).toBeUndefined()
    expect(h.active()).toBe(h.heading)
  })
  it('keeps focus on the pressed button during the request and after a refusal', () => {
    const h = setup(true)
    h.focus(h.button)
    h.commit() // pending: the button is aria-disabled, not disabled
    h.commit() // the refusal and its reread
    expect(h.moves).toEqual([])
    expect(h.answer(h.button)).toBe('pressed')
    expect(h.active()).toBe(h.button)
    h.commit()
    expect(h.moves).toEqual([])
  })
  it.each(['stays on the disabled button', 'falls to body'])('does not depend on the button staying enabled: a disabled one gets focus back after a refusal (%s)', (browser) => {
    const h = setup(true)
    h.focus(h.button)
    h.button.disabled = true
    if (browser === 'falls to body') h.blur()
    h.commit()
    h.button.disabled = false
    h.commit()
    expect(h.moves).toEqual([])
    expect(h.answer(h.button)).toBe('pressed')
    expect(h.active()).toBe(h.button)
  })
  it('moves focus to the message of the card when the form disappears after a success', () => {
    const h = setup(true)
    h.focus(h.button)
    h.commit()
    h.button.connected = false
    h.blur()
    h.commit()
    expect(h.moves).toEqual([])
    expect(h.answer(h.button)).toBe('result')
    expect(h.active()).toBe(h.message)
    h.commit() // the list read that follows the answer
    expect(h.moves).toEqual([])
    expect(h.active()).toBe(h.message)
  })
  it('never takes focus that the person moved while waiting', () => {
    const h = setup(true)
    h.focus(h.button)
    h.commit()
    h.focus(h.jobAction)
    h.button.connected = false
    h.commit()
    expect(h.answer(h.button)).toBeUndefined()
    expect(h.active()).toBe(h.jobAction)
    expect(h.moves).toEqual([])
  })
  it('still rescues an own action of the block outside the cards', () => {
    const h = setup(true)
    h.focus(h.refresh)
    h.refresh.disabled = true
    h.commit()
    expect(h.moves).toEqual([h.heading])
  })
  it('forgets an own action of the block once focus entered a card', () => {
    const h = setup(true)
    h.focus(h.refresh)
    h.focus(h.button)
    h.refresh.connected = false
    h.button.connected = false
    h.blur()
    h.commit()
    expect(h.moves).toEqual([])
  })
})

describe('insideLocalBlock', () => {
  it('excludes focus owners nested in the block, not a block nested in a focus owner', () => {
    const page = node('page', null, true)
    const block = node('block', page)
    const own = node('own action', block)
    const card = node('card', block, true)
    const inner = node('inner action', card)
    const outside = node('outside', page)
    expect(insideLocalBlock(block, own)).toBe(true)
    expect(insideLocalBlock(block, card)).toBe(false)
    expect(insideLocalBlock(block, inner)).toBe(false)
    expect(insideLocalBlock(block, outside)).toBe(false)
  })
})

describe('reviewFocusTarget', () => {
  it.each([
    ['pressed', true, 'pressed'], ['body', true, 'pressed'], ['pressed', false, 'result'], ['body', false, 'result'], ['elsewhere', true, undefined], ['elsewhere', false, undefined],
  ] as const)('active %s, pressed available %s → %s', (active, available, target) => {
    expect(reviewFocusTarget(active, available)).toBe(target)
  })
})
