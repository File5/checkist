import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  moneyDigits, moneyDigitsNames, moneyDigitsStorageKey, parseMoneyDigits, resetMoneyDigits, setMoneyDigits, subscribeMoneyDigits, useMoneyDigits,
} from './money-digits'

type StorageHandler = (event: { key: string | null }) => void

/** A window with a working storage and the `storage` handlers it was given. */
function stubWindow(saved = new Map<string, string>()) {
  const handlers = new Set<StorageHandler>()
  vi.stubGlobal('window', {
    localStorage: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value) } },
    addEventListener: (type: string, handler: StorageHandler) => { if (type === 'storage') handlers.add(handler) },
    removeEventListener: (type: string, handler: StorageHandler) => { if (type === 'storage') handlers.delete(handler) },
  })
  return { saved, handlers }
}

function Shown() {
  return createElement('output', null, useMoneyDigits())
}

describe('«Суммы»: whole units or with cents, a choice of the device (2026-10-13)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    setMoneyDigits('whole')
  })

  it('reads only «cents» as cents; anything else is whole units', () => {
    expect([parseMoneyDigits('cents'), parseMoneyDigits('whole'), parseMoneyDigits(null), parseMoneyDigits(undefined), parseMoneyDigits('копейки'),
      parseMoneyDigits('CENTS'), parseMoneyDigits(2), parseMoneyDigits('')])
      .toEqual(['cents', 'whole', 'whole', 'whole', 'whole', 'whole', 'whole', 'whole'])
    expect(moneyDigitsStorageKey).toBe('checkist.moneyDigits')
    expect(moneyDigitsNames).toEqual([['whole', 'Целые'], ['cents', 'С копейками']])
  })

  it('shows whole units without a browser', () => {
    expect(typeof window).toBe('undefined')
    expect(moneyDigits()).toBe('whole')
    expect(renderToStaticMarkup(createElement(Shown))).toBe('<output>whole</output>')
  })

  it('keeps the choice under its key and reads it back', () => {
    const { saved } = stubWindow()
    resetMoneyDigits()
    expect(moneyDigits()).toBe('whole')
    setMoneyDigits('cents')
    expect(saved.get(moneyDigitsStorageKey)).toBe('cents')
    expect(moneyDigits()).toBe('cents')
    // A fresh page: the stored choice is read again.
    resetMoneyDigits()
    expect(moneyDigits()).toBe('cents')
    setMoneyDigits('whole')
    expect(saved.get(moneyDigitsStorageKey)).toBe('whole')
  })

  it('reads the storage once: later reads come from the module', () => {
    const { saved } = stubWindow(new Map([[moneyDigitsStorageKey, 'cents']]))
    resetMoneyDigits()
    expect(moneyDigits()).toBe('cents')
    saved.set(moneyDigitsStorageKey, 'whole')
    expect(moneyDigits()).toBe('cents')
  })

  it('takes an unknown stored value as whole units', () => {
    stubWindow(new Map([[moneyDigitsStorageKey, 'копейки']]))
    resetMoneyDigits()
    expect(moneyDigits()).toBe('whole')
  })

  it('lives without storage: a blocked one breaks neither the read nor the write, the choice stays in memory', () => {
    vi.stubGlobal('window', { localStorage: { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } } })
    resetMoneyDigits()
    expect(() => moneyDigits()).not.toThrow()
    expect(moneyDigits()).toBe('whole')
    expect(() => setMoneyDigits('cents')).not.toThrow()
    expect(moneyDigits()).toBe('cents')
    // No `addEventListener` on this window either: following and stopping do not throw.
    let stop = () => {}
    expect(() => { stop = subscribeMoneyDigits(() => {}) }).not.toThrow()
    expect(() => stop()).not.toThrow()
  })

  it('tells the listeners about a choice made here', () => {
    const listener = vi.fn()
    const stop = subscribeMoneyDigits(listener)
    setMoneyDigits('cents')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(renderToStaticMarkup(createElement(Shown))).toBe('<output>cents</output>')
    stop()
    setMoneyDigits('whole')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('follows another tab: the `storage` event of its key and of a cleared storage, not of a foreign key', () => {
    const { saved, handlers } = stubWindow()
    resetMoneyDigits()
    const listener = vi.fn()
    const stop = subscribeMoneyDigits(listener)
    expect(handlers.size).toBe(1)
    const [handler] = handlers
    expect(moneyDigits()).toBe('whole')

    saved.set(moneyDigitsStorageKey, 'cents')
    handler({ key: moneyDigitsStorageKey })
    expect(moneyDigits()).toBe('cents')
    expect(listener).toHaveBeenCalledTimes(1)

    // The data of the site was cleared: the key is null, the default is back.
    saved.clear()
    handler({ key: null })
    expect(moneyDigits()).toBe('whole')
    expect(listener).toHaveBeenCalledTimes(2)

    // Another setting changed: nothing is read again and nobody is called.
    saved.set(moneyDigitsStorageKey, 'cents')
    handler({ key: 'checkist.theme' })
    expect(moneyDigits()).toBe('whole')
    expect(listener).toHaveBeenCalledTimes(2)

    stop()
    expect(handlers.size).toBe(0)
    setMoneyDigits('cents')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('forgets the choice for the next test', () => {
    setMoneyDigits('cents')
    expect(moneyDigits()).toBe('cents')
    resetMoneyDigits()
    expect(moneyDigits()).toBe('whole')
  })
})
